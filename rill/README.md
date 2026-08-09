# Rill as a declarative dashboard layer

Rill's contribution to this project is not a chart library — Evidence and noodle
already draw. It is the idea that **a dashboard is a file**: a metrics view
declares dimensions and measures, an explore declares which of them are on the
board and what it opens on, and the tool renders that and nothing else. Nothing
is clicked into existence, so nothing can be lost, diffed badly, or disagree
with the version somebody else is looking at.

This directory is a real Rill project in Rill's own schema. `rill start rill/`
renders it. So does `/rill` on this site, without Rill running.

```
rill.yaml                      project
models/orders_enriched.sql     one row per order, customer country attached
metrics/orders_metrics.yaml    the governed dimensions and measures
explores/revenue.yaml          which of them are on the board
```

## Two resolvers, one model

The model reads parquet:

```sql
from read_parquet('data/dbt_semantic/orders/orders.parquet') o
```

Rill resolves that against `./data`, which `up.sh` copies from Evidence's build
output. `scripts/build-rill-model.mjs` rewrites the same call to
`dbt_semantic.orders` — the table Evidence has already registered in
duckdb-wasm — and writes the result to `components/rill/model.generated.js`.

The rewrite is deliberately rigid: exactly
`read_parquet('data/<source>/<table>/<table>.parquet')`, nothing computed, no
globs. A looser rule would accept a path Evidence has no table for and the
failure would surface three layers away as "table does not exist".

Because both sides come from one file, the join grain, the `coalesce`, and the
column list cannot differ between the two renderings.

## Running it

```bash
npm run sources        # produce the parquet
npm run rill:model     # compile rill/ for the browser (also run by postinstall)
./rill/up.sh           # the real Rill, at http://localhost:9009
./rill/up.sh down
```

`up.sh` prefers a native `rill` binary (`curl https://rill.sh | sh`) and falls
back to `rilldata/rill` in podman or docker. It runs the generator's `--check`
first: if the YAML and the compiled module have drifted, the two renderings are
already different dashboards and starting Rill would only hide that.

## What the generator enforces

Rill's own loader will reject malformed YAML. What it cannot know is whether a
measure that advertises `valid_percent_of_total` can actually be summed across a
partition — and that claim is what draws a "% of total" column.

```yaml
- name: customers
  expression: count(distinct customer_id)
  valid_percent_of_total: true      # rejected
```

> `measure "customers" claims valid_percent_of_total, but
> `count(distinct customer_id)` does not add up across a partition — a share of
> it would print parts that exceed the whole`

The test errs toward refusal. Refusing an additive measure costs a column;
accepting a non-additive one prints parts that exceed their whole, and nothing
crashes to tell you. The same pass rejects an unknown `format_preset`, a
`format_d3` spec outside the subset this project can render, a duplicate field
name, a dashboard defaulting to a range it does not offer, and an explore
selecting a field the metrics view does not have.

## What is not implemented

This is Rill's dashboard model, not Rill. Absent, in rough order of how much
they would be missed:

- **`security:`** — row-level access policies. The YAML key parses; nothing
  enforces it. A static site has no user to enforce it against, and a filter
  applied in the browser is not a security control. Do not put a policy here and
  believe it.
- **Pivot mode**, and dimension-vs-dimension comparison (`comparison_mode:
  dimension`). Noodle covers the same ground with shelves.
- **Alerts, scheduled reports, bookmarks, embed tokens** — all need a server.
- **`theme:`**, `time_zones:`, `lock_time_zone:`. Times are UTC throughout; see
  the note in `components/rill/engine/timerange.js` for why that is load-bearing
  rather than lazy.

Keys that are not implemented are ignored rather than rejected, so this
directory stays valid for `rill start`. That is the trade: a key can be set here
and silently do nothing on the Evidence side. The generator names the ones it
reads; anything else is Rill-only.

## Verifying

```bash
npm run test:rill      # SQL and formats, cross-checked against control queries
npm run test:rill:ui   # the dashboard in a real browser
```

`tests/t-rill.mjs` recomputes every headline measure, leaderboard and comparison
window with an independent DuckDB query written against the raw parquet rather
than against the generated view, and requires agreement. It also re-runs the
time-range arithmetic under five timezones, because the boundary maths is the
one part of this that a single-timezone test cannot see.
