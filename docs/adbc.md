# ADBC sources

[Arrow Database Connectivity](https://arrow.apache.org/adbc/) is JDBC's idea with
Arrow as the wire format: one client interface, a driver per database, columnar
results end to end. `connectors/adbc` exposes it to Evidence as a single source
type with seven flavors.

It sits **alongside** the built-in connectors, not in place of them. The reason
to use it is type fidelity.

## Why: types are read, not guessed

Evidence's built-in connectors receive untyped rows and infer each column from
its first values, marking the result `inferred`. A column that starts with nulls,
or integers arriving as strings, gets the wrong answer.

ADBC returns an Arrow schema, so the type is known:

```
duckdb via ADBC:  n:number/precise   first_order:date/precise
```

Every column above is `precise`. That is the whole pitch.

## Setup

```bash
npm run adbc:drivers        # installs the five driver binaries
npm run test:adbc           # verifies what is reachable from here
```

Driver binaries are **not** bundled — they are per-platform native libraries
totalling hundreds of MB. `dbc` puts them where the driver manager looks:

```bash
npx @columnar-tech/dbc search           # everything available
npx @columnar-tech/dbc install trino    # anything not in the five above
```

## Flavors

| flavor | driver | notes |
|---|---|---|
| `postgresql` | postgresql | ✅ recommended |
| `clickhouse` | clickhouse | ✅ recommended |
| `snowflake` | snowflake | driver verified; no account here |
| `bigquery` | bigquery | driver verified; no project here |
| `duckdb` | duckdb | ⚠️ **not usable inside Evidence** — see below |
| `ducklake` | duckdb + extension | ⚠️ same |
| `motherduck` | duckdb + `md:` | ⚠️ same |

```yaml
# sources/warehouse/connection.yaml
name: warehouse
type: adbc
options:
  flavor: clickhouse
  host: 127.0.0.1
  port: 8123
  user: default
  password: clickhouse
  database: default
```

## The DuckDB conflict

**Do not use the `duckdb`, `ducklake` or `motherduck` flavors inside Evidence.**

The ADBC DuckDB driver bundles its own libduckdb (1.5.x). Evidence embeds a
different one via `@duckdb/node-api` (1.4.2) and duckdb-wasm. Loaded into one
process they resolve each other's symbols, and nothing complains until something
touches the storage layer:

```
select 1                 -> fine
select * from a_table    -> INTERNAL Error: Attempted to dereference unique_ptr that is NULL!
                            (C++ stack trace, no mention of ADBC)
```

The connector now refuses this combination up front and explains it, rather than
letting the process corrupt itself. Outside Evidence — scripts, notebooks,
`npm run test:adbc` — there is only one libduckdb and all three flavors work
normally, which is why they are still shipped.

This costs nothing in practice: Evidence *embeds* DuckDB, so routing DuckDB
through ADBC was never buying anything. Use `type: duckdb` or `type: motherduck`
for those. ADBC earns its place on the databases Evidence reaches over a network.

## Cube's SQL API does not work through the postgres driver

The ADBC postgresql driver moves results with `COPY ... TO STDOUT (FORMAT
binary)`. Cube's SQL API speaks the postgres wire protocol but does not implement
`COPY`, so it answers:

```
Unsupported query type: COPY (SELECT ...) TO STDOUT (FORMAT binary)
```

Use `@evidence-dev/postgres` for Cube (see [cube/README.md](../cube/README.md)).
`npm run test:adbc` asserts this stays true, so if Cube ever adds `COPY` the test
will say so.

## Type quirks worth knowing

Both are driver behaviour, not connector bugs, and neither is detectable from the
data alone.

**PostgreSQL `NUMERIC` arrives as text.** The driver sends Arrow `Utf8` because
arbitrary-precision decimal has no lossless Arrow float. `sum(amount)` therefore
comes back as `"175.50"`, a string, and will not plot. Cast when you want a
number:

```sql
select sum(amount)::float8 as total from orders
```

**ClickHouse `DateTime` arrives as an integer.** It maps to Arrow `Uint32` —
epoch seconds, indistinguishable from a count, so nothing downstream can know it
is a date. `Date32` and `DateTime64` carry real temporal types:

```sql
select toDateTime64(ordered_at, 3) as ordered_at from orders   -- becomes a Date
```

## Test infrastructure

`npm run test:adbc` skips what is not running rather than failing.

```bash
podman run -d --name pg-adbc -p 15433:5432 \
  -e POSTGRES_PASSWORD=evidence -e POSTGRES_USER=evidence -e POSTGRES_DB=evidence \
  docker.io/library/postgres:16-alpine

podman run -d --name clickhouse-adbc -p 8123:8123 -p 9000:9000 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=clickhouse \
  docker.io/clickhouse/clickhouse-server:latest
```

Snowflake, BigQuery and MotherDuck are tested as far as credentials allow: the
suite asserts the driver loads, is handed its options, and fails at
*authentication* — reported as `wire`. That separates "wired up, no account" from
"broken", which is the distinction that matters when you do add credentials. Set
`SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER` / `SNOWFLAKE_PASSWORD`,
`BIGQUERY_PROJECT` / `GOOGLE_APPLICATION_CREDENTIALS`, or `MOTHERDUCK_TOKEN` and
those rows become real connections.

## Option names that are not guessable

Found by trial against the real drivers; each wrong guess fails in a way that
does not suggest the fix.

- **ClickHouse** speaks the **HTTP** interface (8123), not the native protocol
  (9000) — port 9000 gives `network error (Connect)`. Credentials must be
  separate options; embedded in the URI they are ignored and ClickHouse answers
  `Code: 194 Authentication failed`. The database must not be a URI path —
  `/foo` is read as an HTTP handler name (`There is no handle /foo`).
- **BigQuery** ADC is `adbc.bigquery.sql.auth_type.auth_bigquery`. The obvious
  `...auth_type.default` is rejected outright.
- **Snowflake** uses `username`, not `user`, and `adbc.snowflake.sql.account`.

The connector maps ordinary Evidence options onto these, so `connection.yaml`
stays conventional.
