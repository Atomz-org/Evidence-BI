# Evidence BI — dbt semantic layer edition

BI-as-code that competes with Looker and Power BI on the two things that matter:
**governed metrics** (dbt semantic layer is the single source of truth) and
**designed dashboards** (a validated, CVD-safe color system and a dashboard
grammar encoded as a Claude skill).

## Architecture

```
dbt project (example-order-revenue-mart)
  models/semantic/_semantic_models.yml    entities, dimensions, measures
  models/semantic/_metrics.yml            metrics + saved queries   ← definitions live HERE
        │  dbt build → marts in dev.duckdb
        ▼
scripts/sync-dbt.sh                       copy dev.duckdb → sources/dbt_semantic/
sources/dbt_semantic/*.sql                extract marts (orders, customers, time spine)
queries/metrics/<metric>.sql              the COMPILED semantic layer — one file per dbt metric
queries/saved/<name>.sql                  compiled dbt saved_queries
pages/*.md                                dashboards: filter + aggregate + render only
```

Pages never restate business logic. If a dashboard needs a number that doesn't
exist, the fix is a dbt metric PR, then a recompile — that discipline is what
makes this Looker-class rather than a folder of charts.

## Quickstart

```bash
npm install
./scripts/sync-dbt.sh        # copies the built dbt DuckDB + runs `npm run sources`
npm run dev                  # dashboards on localhost:3000
```

To rebuild the dbt project first: `REBUILD=1 ./scripts/sync-dbt.sh`
(uses the `code-skills/.venv` dbt; override with `DBT_BIN` / `DBT_PROJECT_DIR`).

## Pages

- **`/` Revenue Overview** — executive dashboard: KPI row with previous-period
  comparisons, cumulative momentum (trailing 28d, MTD), MoM growth, daily trend,
  weekly revenue by region, and a drill table.
- **`/regions/<region>`** — templated drill-down per region: filtered KPIs,
  trend, and a full order log for audit.
- **`/metrics` Metric Dictionary** — every metric's definition, type, caveats,
  and a live value computed from the compiled query (drift shows up here first).

## The skill

`.claude/skills/evidence-bi/` loads automatically for Claude sessions in this
project and encodes:

- `SKILL.md` — the metric-first procedure and non-negotiables
- `references/design-principles.md` — form choice, page anatomy, the color
  system (validated light + dark), anti-patterns
- `references/components.md` — exact Evidence component syntax, verified
  against the installed version
- `references/dbt-semantic-layer.md` — the dbt→Evidence compilation contract
  (simple / ratio / derived / cumulative metrics, naming, governance)

The chart palettes in `evidence.config.yaml` pass all six checks of the dataviz
color validator (lightness band, chroma floor, CVD ΔE ≥ 8, normal-vision
ΔE ≥ 15, contrast) on this project's real surfaces in both light and dark mode.

## Data sources

All Evidence connectors are installed and enabled (`evidence.config.yaml`):
DuckDB (the dbt bridge), BigQuery, Snowflake, Postgres, MySQL, SQL Server,
Databricks, Trino, MotherDuck, SQLite, CSV, Google Sheets
(`@evidence-dev/connector-gsheets`), and JavaScript sources. In production,
point the matching connector at the warehouse schema where dbt's
`saved_queries` exports land (`bi_marts`) — the `queries/` layer and pages stay
unchanged.

`sources/needful_things/` is the stock Evidence demo source (unused by the
dashboards; kept for experiments).

If SQLite complains about a missing native binding after install:
`cd node_modules/sqlite3 && npm run install` (fetches the prebuilt binary).

## Commands

```bash
npm run sources        # re-extract sources after a sync
npm run dev            # dev server
npm run build          # production build (fails on broken queries — the CI gate)
npm run preview        # preview the production build
```

## Evidence docs

- [Evidence docs](https://docs.evidence.dev/) · [GitHub](https://github.com/evidence-dev/evidence) · [all evidence-dev repos](https://github.com/orgs/evidence-dev/repositories)
