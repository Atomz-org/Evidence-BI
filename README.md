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
- **`/showcase` Feature Tour** — the demo page. Ten chapters, each answering a
  real question *and* naming the capability behind it: prose that recomputes,
  a four-input filter row, KPIs with previous-period deltas, a trend whose grain
  and target line are driven by inputs, composition + weekday heatmap,
  distribution (histogram / box plot), a Sankey of region→order-state, country
  concentration, chip-based cross-filtering with no SQL, a table with in-cell
  bars, deltas, colour scales and sparklines, and the governance trail from
  dbt YAML → compiled SQL → page.
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

## Knowledge graph (agent retrieval)

`graphify-out/graph.json` is a queryable knowledge graph of this project with
**column-level lineage**: page → query file (frontmatter + `${}` chains) →
source extract → dbt mart, and column → column edges whose `context` carries
the defining SQL expression. graphify's AST pass can't see Evidence's
frontmatter conventions, so after any `/graphify` rebuild re-inject lineage:

```bash
$(cat graphify-out/.graphify_python) scripts/graphify-lineage.py   # needs sqlglot
```

Agents answer metric questions from the graph in <0.5s instead of reading files:

```bash
graphify explain "revenue_trailing_28d.revenue_trailing_28d"   # definition, upstream cols, consumers
graphify query "which pages use order_amount_usd?"
graphify path "Revenue Overview" "marts.fct_orders"
```

## Upstream Evidence source (`vendor/`)

Two upstream repos are vendored as **git submodules**, each pinned to a commit
on `main`, so component and connector APIs can be read, diffed, and traced
locally instead of guessed from docs:

| Path | Upstream | Contains |
|---|---|---|
| `vendor/evidence` | [evidence-dev/evidence](https://github.com/evidence-dev/evidence) | core-components, CLI, all bundled connectors |
| `vendor/evidence-datasources` | [evidence-dev/datasources](https://github.com/evidence-dev/datasources) | Google Sheets + InfluxDB connectors |

Together they cover **all 15** packages in `package.json`.

```bash
git submodule update --init --recursive --depth 1   # first checkout (or clone with --recurse-submodules)
./scripts/sync-evidence-upstream.sh                 # pull latest upstream + report version drift
./scripts/sync-evidence-upstream.sh --check         # drift report only, no fetch
```

Two things to be clear about:

- **A submodule pins a commit — upstream changes are not picked up silently.**
  That is the point: the sync script is the deliberate update, and the pointer
  move gets committed and reviewed like any other change.
- **The app runs against `node_modules`, not these checkouts.** The submodules
  are the readable reference (unminified source, stories, tests, git history).
  The sync script's drift check compares vendored versions against the ones
  `package.json` installs — currently all 15 match.

Note that `evidence-dev/datasources` is a low-traffic repo (last upstream push
June 2024), so the Google Sheets connector there moves far more slowly than the
main monorepo. A `--check` run that reports "no upstream change" for it is
normal, not a broken fetch.

`vendor/` is excluded from the knowledge graph via `.graphifyignore` — ~3k
upstream files would swamp this project's own graph. To graph it, run
`/graphify vendor/evidence` separately.

## Evidence docs

- [Evidence docs](https://docs.evidence.dev/) · [GitHub](https://github.com/evidence-dev/evidence) · [all evidence-dev repos](https://github.com/orgs/evidence-dev/repositories)
