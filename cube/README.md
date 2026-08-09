# Cube as noodle's semantic layer

Evidence owns presentation; dbt owns the facts. Cube sits between them as the
**relationship layer** — the thing that knows a measure's aggregation, which
cubes can be joined to which, and what a segment means. When noodle runs on
Cube, dropping a field on a shelf produces a *Cube query*, not SQL, and the
number that comes back is the number the model defines.

The point is that a metric has one definition. A notebook that recomputes
revenue in pandas has quietly forked it; `evidence.cube(...)` cannot.

## Running it locally

```bash
npm run sources     # produce the parquet Cube reads
./cube/up.sh        # start Cube over it
./cube/up.sh down   # stop
```

Then:

| | |
|---|---|
| Playground | http://localhost:4000 |
| REST | http://localhost:4000/cubejs-api/v1 |
| SQL API | `postgres://cube:cube@localhost:15432/cube` |

`npm run cube:up` runs the same thing through `docker compose` where a Docker
daemon is available. On macOS with podman the compose path fails — the podman VM
is denied access to `~/Documents`, `~/Desktop` and `~/Downloads` by the OS
privacy layer — so `up.sh` detects the refusal and stages the model and parquet
into a temp directory instead. Staged mode is a copy: re-run `up.sh` after
editing a model file.

## The three ways in

**1. The exploration surface.** Pass a `cube` prop and noodle builds its field
catalogue from `/meta` instead of from parquet:

```svelte
<Noodle cube={{ apiUrl: 'http://localhost:4000' }} />
```

Measures arrive with their aggregation already decided by the model, so the
aggregation dropdown is disabled for them and says why. Joins come from Cube's
`connectedComponent`, so noodle can refuse two cubes that have no path between
them and explain that instead of surfacing a Cube planning error.

**2. Notebooks.**

```python
import evidence

df = evidence.cube({
    "measures": ["orders.revenue"],
    "dimensions": ["orders.region"],
    "timeDimensions": [{"dimension": "orders.ordered_at", "granularity": "month"}],
    "segments": ["orders.not_cancelled"],
})
evidence.data(df, "revenue")
```

Measures come back as numbers and time dimensions as datetimes — Cube sends both
as strings. `evidence.cube_meta()` lists the model without leaving the notebook.
Point it elsewhere with `CUBE_API_URL` / `CUBE_API_TOKEN`.

**3. `sources/` via the SQL API.** Cube speaks the Postgres wire protocol, so
the existing connector works unmodified:

```yaml
# sources/cube/connection.yaml
name: cube
type: postgres
options:
  host: localhost
  port: 15432
  database: cube
  user: cube
  password: cube
```

Measures must be wrapped in `MEASURE()` in this dialect:

```sql
select region, DATE_TRUNC('month', ordered_at) as month, MEASURE(revenue) as revenue
from orders group by 1, 2
```

## The timestamp trap

**Month buckets silently land in the previous month, and how wrong they are
depends on where the code runs.** This affects *both* Cube APIs, and it is the
single most likely thing to go unnoticed in this integration.

Cube sends a truncated month without a timezone:

| API | value on the wire |
|---|---|
| REST | `"2026-07-01T00:00:00.000"` |
| SQL API | `2026-07-01 00:00:00` as `timestamp without time zone` |

Both are correct. Both get localised by their client:

- `new Date("2026-07-01T00:00:00.000")` — ECMAScript reads a date-**time**
  string with no offset as *local* time. In Asia/Tokyo that is
  `2026-06-30T15:00:00Z`; July's revenue plots under June.
- node-postgres parses `timestamp without time zone` (OID 1114) the same way.

The asymmetry that hides it: a date-**only** string (`"2026-07-01"`) *is*
specified as UTC, so short dates look right while granulated timestamps drift.
And in UTC — where CI usually runs — nothing is wrong at all. Totals stay
correct, nothing throws, the chart is just shifted.

Setting `CUBEJS_TIMEZONE=UTC` on the server does **not** fix it; the value Cube
sent was already right. The fix is client-side, in two places:

**REST** — handled for you in `normalizeCubeResult` (`engine/cube.js`), which
pins offset-less timestamps to UTC before reviving them.

**SQL API** — if you point `sources/` at Cube through the postgres connector,
set the parsers yourself:

```js
import pg from 'pg';
pg.types.setTypeParser(1114, (v) => new Date(`${v.replace(' ', 'T')}Z`)); // timestamp
pg.types.setTypeParser(1082, (v) => new Date(`${v}T00:00:00Z`));         // date
```

`npm run test:cube` runs `tests/t-cube-tz.mjs`, which re-checks the REST path
under UTC, Europe/Oslo, Asia/Tokyo, America/Los_Angeles and Pacific/Kiritimati —
a single-timezone test cannot see this class of bug.

The notebook client is unaffected: pandas `to_datetime` leaves an offset-less
string as a naive timestamp with the same wall-clock value, so no shift occurs.

## Verifying

```bash
npm run test:cube      # 34 integration assertions + generated SQL executed
```

Every number is cross-checked against an independent DuckDB control query over
the same parquet, so the tests fail if Cube and DuckDB ever disagree — that is
the property worth protecting, not the specific values.

`tests/t-cube.mjs` covers the REST path: joins Cube resolves itself, segments,
filters, time grains, calculated measures, table calculations over Cube rows,
and the refusal of disconnected cubes. `tests/t-cubesql.mjs` takes every SQL
statement noodle would export, runs it on the live SQL API, and checks it agrees
with the REST result for the same view.

## Model layout

`model/cubes/*.yml` reads the Evidence-generated parquet directly through
DuckDB, which keeps this harness honest: Cube and the DuckDB path are looking at
literally the same bytes, so a disagreement is a real disagreement.

Against a warehouse, only the `sql:` block of each cube changes.
