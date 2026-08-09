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
- **`/reports/revenue-performance` Order Revenue Performance** — the same figures as
  a management report rather than a dashboard: control block (report ID, period,
  data as-of, owner, classification), queried comparatives, accounting number
  formats (adverse values in parentheses), numbered exhibits each naming the
  compiled query behind it, a materiality threshold on small-base movements, and a
  basis-of-preparation section with the metric register and lineage. Sections break
  onto their own pages in print and the filter row is hidden.
- **`/regions/<region>`** — templated drill-down per region: filtered KPIs,
  trend, and a full order log for audit.
- **`/metrics` Metric Dictionary** — every metric's definition, type, caveats,
  and a live value computed from the compiled query (drift shows up here first).
- **`/noodle` Explore** — the drag-and-drop exploration workbench: shelves, Show
  Me, level-of-detail expressions, table calculations, click-to-filter, and an
  export back to Evidence markdown. See [noodle](#noodle--the-exploration-surface).
- **`/studio` Studio** — build a whole dashboard or report at runtime: several
  views on one canvas, slicers, cross-filtering by clicking a mark, save/export,
  and *Publish as code* to turn it into an Evidence page. See
  [Studio](#studio--dashboards-and-reports-built-at-runtime).
- **`/gallery`** — the component set and the layout system, each shown working
  on real data.
- **`/flint` Flint Charting** — the semantic charting path. `<FlintChart>` takes
  the columns' *meaning* (`Amount`, `Region`, `Date`) and lets
  [flint-chart](https://github.com/PackMaaan/flint-chart) derive the layout —
  axis steps, label rotation, legend placement, when to wrap into facets. See
  [Flint charting](#flint-charting).
- **`/notebooks/order-anomalies` Revenue Anomaly Detection** — authored as a
  Jupyter notebook (`pages/notebooks/order-anomalies.ipynb`), not markdown. A
  pandas screen over the governed `revenue` metric, on one page with SQL KPIs
  from the semantic layer. See [Jupyter notebooks as pages](#jupyter-notebooks-as-pages).

## noodle — the exploration surface

`/noodle` is a drag-and-drop workbench built on this project's semantic layer.
Fields go onto **shelves**; the shelves are the specification; the SQL *and* the
chart are both derived from it. Changing the mark never touches the query, and
changing the query never touches the mark.

`<Noodle/>` is auto-imported like any component in [components/](components/):

```svelte
<Noodle
    tables={['dbt_semantic.orders', 'dbt_semantic.customers']}
    relationships={[{ from: 'dbt_semantic.orders', to: 'dbt_semantic.customers',
                      on: [['customer_id', 'customer_id']], type: 'left' }]}
/>
```

The engine is plain JavaScript with no framework in it, so it is testable
without a browser — [components/noodle/engine/](components/noodle/engine/):

| Module | Responsibility |
|---|---|
| `catalog.js` | introspects the warehouse; the relationship layer and join planning |
| `spec.js` | the shelf algebra — pills, shelves, and the operations on them |
| `compile.js` | specification → one SQL statement, including level-of-detail |
| `tablecalc.js` | running total, moving average, percent of total, rank |
| `showme.js` | ranks the marks that suit the fields, with the reason for each |
| `encode.js` | the chart, on the validated palette, light and dark |
| `export.js` | the view back out as Evidence markdown |

**Granularity is the whole idea.** A view's grain is the dimensions on its
shelves; measures aggregate up to it.

**Level-of-detail expressions** compute at a *different* grain and come back:
`FIXED` ignores the view's grain, `INCLUDE` adds to it, `EXCLUDE` subtracts.
Each compiles to its own grouped CTE, is paired *distinctly* with the view's
grain, then aggregated in — the distinct pairing is what stops the outer
aggregate being silently weighted by underlying row counts, which is the
difference between `AVG` meaning the mean of the inner results and meaning a
row-weighted mean.

**Table calculations** are computed over the result along a **field**, not along
the screen. A calculation addressed to "across the table" changes meaning the
moment Rows and Columns are swapped; addressed to a date it survives any layout.

**The design system is enforced during exploration, not just in published
pages.** Show Me picks by the job the data is doing and says why; the surface
warns when a chart leans on the palette's low-contrast light-mode slots, and
when series count exceeds what colour can carry.

**Exploration ends in code.** *Copy as Evidence markdown* emits the `sql` block
and the component, ready to paste into a page and be reviewed and versioned.
Nothing built on `/noodle` is governed until it goes through that door — the page
says so.

### Not built yet

The **relationship** layer (logical links) and the **physical** join it resolves
to are live. **Data blending** — aggregating genuinely separate sources to a
common grain and matching on shared dimensions, for warehouses that cannot be
joined at all — is not, and neither is heterogeneous federation via an external
service such as WrenAI. A field whose table has no declared path to the view's
primary table is reported rather than silently cross-joined, so the gap is
visible rather than wrong.

## Studio — dashboards and reports, built at runtime

`/studio` is the composition layer above noodle: several views on one canvas,
sharing one filter context, saved, and published back to Evidence markdown.

```svelte
<Studio
    tables={['dbt_semantic.orders', 'dbt_semantic.customers']}
    relationships={[{ from: 'dbt_semantic.orders', to: 'dbt_semantic.customers',
                      on: [['customer_id', 'customer_id']], type: 'left' }]}
/>
```

The interactions are the ones Power BI and Tableau established — slicers,
cross-filter by clicking a mark, tile layout, duplicate, present, print — and
**a tile is nothing but a noodle spec**, so pressing *Edit* opens the same
worksheet, with the same Show Me, level-of-detail expressions and table
calculations. There is one place a view is built and one place it is drawn.

| Module | Responsibility |
|---|---|
| `engine/dashboard.js` | the tile model, filter composition, save/open, publish |
| `engine/runner.js` | spec → rows, for both backends, with stale-result guarding |
| `noodle/Tile.svelte` | one view drawn; reports clicks, never interprets them |
| `Studio.svelte` | the canvas, the filter bar, and the two exits |

Four decisions are worth knowing about:

**The filter context is merged at query time, never written into the tile.** A
tile is always the thing its author drew, so clearing the page restores it
exactly and a saved dashboard never carries somebody's transient click.

**A cross-filter does not filter the view that raised it** — that view keeps its
whole distribution with the selection highlighted. Filter the source and the
bars you would have to click to change your mind vanish with it.

**A filter that cannot reach a view is reported on the view.** A dashboard mixes
sources; when there is no join path, most tools drop the filter silently and
leave filtered and unfiltered numbers side by side looking comparable. Here the
view names the field it could not be filtered by.

**Publishing emits a working page, not a snapshot.** Page filters leave as real
Evidence `<Dropdown>` inputs. The compiler is not re-implemented to do it: the
filter is compiled with a unique sentinel literal and the literal is swapped for
`${inputs.x.value}` afterwards, so the published SQL *is* the SQL that ran.
`npm run test:dashboard` proves it by running the published query with a value
substituted and comparing it to the compiled control.

A **report** is not a styled dashboard: fixed measure, one exhibit per row on
screen and on the page, a basis-of-preparation block, and numbered exhibits with
source lines when it publishes.

### Not built yet

Tiles flow into a twelve-column grid rather than sitting at absolute
coordinates — deliberate, since a flow reads on a laptop, a phone and paper
without three separate layouts, but it does mean no free-form canvas and no
overlapping tiles. Evidence's `<Grid>` carries no per-child span, so unequal tile
widths collapse to "how many sat in that row" when published. Saves live in
`localStorage`; sharing is by **Export**, which writes the same JSON to a file.

## Jupyter notebooks as pages

Any `.ipynb` under `pages/` **is** a page. `pages/notebooks/churn.ipynb` serves at
`/notebooks/churn`, hot-reloads on save, and runs SQL, components, themes and
prerendering through exactly the same pipeline as a `.md` page — because it is
compiled to one before that pipeline ever sees it.

This is a change to Evidence core, not a generator script. It lives in the vendored
monorepo where it can go upstream, and `scripts/apply-notebook-core.mjs` installs it
into the `@evidence-dev/evidence` that npm actually runs (wired to `postinstall`):

| Path | What it is |
|---|---|
| `vendor/evidence/packages/evidence/notebook/` | the notebook → page compiler (no dependencies) |
| `vendor/evidence/packages/evidence/cli.js` | page-pipeline wiring, in `runFileWatcher` |
| `evidence.py` | the python helper, imported from notebooks |

**Evidence renders a notebook's saved outputs — it never executes the kernel.**
Re-run the notebook in Jupyter and save; the page recompiles on write. Nothing
arbitrary runs at build time.

### Getting values onto the page

Markdown cells are already Evidence markdown, so components and ```` ```sql ```` blocks
work with no helper at all. Use `evidence.py` when a *Python value* has to reach the page:

```python
import evidence

evidence.data(df, "revenue")        # -> `revenue`, bindable by any component
evidence.md(f"## {region}")         # computed Evidence markup, verbatim
evidence.component("BigValue", data=evidence.ref("revenue"), value="total")
evidence.frontmatter(title="Q3")    # same keys as a .md page's --- block
```

Datasets are inlined into the page, so aggregate in the notebook — a frame past
~20k rows warns. pandas datetime columns are revived as JavaScript `Date`s so
time-series components work unchanged.

### Controlling what is shown

A notebook is an analysis document; a page is a report. By default prose and
results are kept and the machinery is not: **code hidden, outputs shown, stdout
hidden, tracebacks shown**. Override per notebook in `metadata.evidence`
(`show_code`, `show_output`, `show_stdout`, `show_errors`, plus any frontmatter
key), or per cell with tags:

`evidence:hide` · `evidence:show-input` · `evidence:hide-output` · `evidence:show-stdout` · `evidence:raw`

nbconvert/JupyterBook tags (`remove-cell`, `remove-input`, `hide-input`, …) are
honoured too, so notebooks that already declare this keep their behaviour.

Outputs map by mimetype: `text/markdown` is emitted as Evidence markup verbatim
(this is how Python writes components); images become cached static assets;
script-bearing HTML — plotly, altair, bokeh — renders in a sized `srcdoc` iframe;
plain HTML such as a pandas repr is injected directly; tracebacks are
ANSI-stripped. Save figures transparent (`savefig(..., transparent=True)`) so they
sit on both the light and dark surface.

## Flint charting

`<FlintChart>` ([`components/FlintChart.svelte`](components/FlintChart.svelte)) is
the semantic path to a chart. Evidence's own components are right when the form
is already decided — `<LineChart>` draws a line and you tune the rest by hand.
Flint answers the other question: hand it the columns and what they **mean**, and
it derives the layout.

```svelte
<FlintChart
    data={weekly}
    chartType="Line Chart"
    x=week y=revenue series=region
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    fmt=usd0k
    title="Weekly revenue by region"
    subtitle="USD, excludes cancelled orders"
/>
```

`Amount` says money, so zero is a meaningful baseline and the axis starts there.
`Region` says place, so the values are categorical. `Date` says time, so the tick
format follows the span. Change only `chartType` and all of that still holds.

Division of labour:

| Layer | Owns |
|-------|------|
| [flint-chart](https://github.com/PackMaaan/flint-chart) `assembleECharts` | Structure — mark, scales, axis steps, label rotation, faceting, overflow |
| [`components/flint/theme-bridge.js`](components/flint/theme-bridge.js) | Ink — the validated palette, chrome, fonts, Evidence number formats |
| [`components/FlintChart.svelte`](components/FlintChart.svelte) | Data, responsiveness, theme switching, failing loudly |

**Colour is not Flint's.** Its ten `theme_spec` houses (economist, swiss, nature,
…) are realized by the Vega-Lite assembler only — the ECharts assembler accepts
the field and ignores it, so an option arrives wearing stock ECharts hues that
are not CVD-checked against this project's surfaces. The bridge re-inks every
option from `evidence.config.yaml` before it is drawn, keeping series *n* on
palette slot *n* because slot order is the CVD-safety mechanism.

Flint is a chart compiler, not a data layer: reshape in the query block, which in
this project means starting from a metric in `queries/metrics/`.

```bash
npm run test:flint          # asserts the palette, chrome and formats reach the option
npm run dashboard:audit     # scores every page against the design contract
```

37 chart types, 44 semantic types, and worked recipes are catalogued in
`.claude/skills/flint-chart/`. Live examples: [`/flint`](pages/flint.md).

## The skills

`.claude/skills/` loads automatically for Claude sessions in this project.

### `evidence-bi` — the standard

Encodes:

- `SKILL.md` — the metric-first procedure and non-negotiables
- `references/design-principles.md` — form choice, page anatomy, the color
  system (validated light + dark), anti-patterns
- `references/components.md` — exact Evidence component syntax, verified
  against the installed version
- `references/dbt-semantic-layer.md` — the dbt→Evidence compilation contract
  (simple / ratio / derived / cumulative metrics, naming, governance)
- `references/enterprise-reporting.md` — management/board packs: control block,
  basis of preparation, accounting formats, queried comparatives, materiality,
  print and export

The chart palettes in `evidence.config.yaml` pass all six checks of the dataviz
color validator (lightness band, chroma floor, CVD ΔE ≥ 8, normal-vision
ΔE ≥ 15, contrast) on this project's real surfaces in both light and dark mode.

### `flint-chart` — authoring a chart

The 37-template catalog with the channels each accepts, all 44 semantic types
with what each implies, working recipes per job, and the anti-patterns. Both
reference files are generated from the installed library, with the regeneration
command at the top.

### `dashboard-loop` — finishing one

The cycle that terminates: frame → draft → score → critique → fix one thing →
repeat. `npm run dashboard:audit` scores a page against the non-negotiables
mechanically (`100 − 3×errors − warnings`), so passes are comparable; seven fixed
critique questions cover what a rule cannot see. Exit is zero errors, all seven
questions passing, and a green build.

```bash
npm run dashboard:audit -- pages/index.md    # one page
npm run dashboard:audit -- --json            # diff between passes
```

A page can opt out of a rule it genuinely does not apply to with
`<!-- audit-ignore: rule-id -->`. It names rules individually; there is no "all".
`references/rubric.md` documents every rule and its fix;
`references/worked-example.md` is a real trace from 76/100 to clean.

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

If SQLite complains about a missing native binding after install
(`Cannot find module .../napi-v6-darwin-unknown-arm64/node_sqlite3.node`, which
fails *all* of `evidence sources`, not just SQLite):

```bash
cd node_modules/sqlite3 && npx --no-install node-pre-gyp install --fallback-to-build
```

`npm rebuild sqlite3` will not fix it and exits reporting success: a global
`allow-scripts` allowlist in `~/.npmrc` suppresses sqlite3's install hook, so the
prebuilt binary is never fetched. Add `sqlite3` to that list to make it stick
across reinstalls.

## Commands

```bash
npm run sources        # re-extract sources after a sync
npm run dev            # dev server
npm run build          # production build (fails on broken queries — the CI gate)
npm run preview        # preview the production build
npm run notebooks      # re-apply the native-notebook core patch (also runs on postinstall)

npm run dashboard:audit          # score every page against the design contract
npm run dashboard:audit -- pages/index.md --json

./cube/up.sh           # local Cube over this project's parquet (./cube/up.sh down to stop)
npm run cube:up        # same, via docker compose where a Docker daemon is available

npm run test:noodle    # 37 assertions: spec -> SQL, LOD, table calcs, Show Me
npm run test:dashboard # 29 assertions: filter composition, save/open, published SQL
npm run test:notebook  # 44 assertions: serializer escaping + notebook compiler
npm run test:cube      # 34 assertions + every generated SQL executed on Cube (needs cube/up.sh)
npm run test:flint     # 12 assertions: palette, chrome, formats and the chart audit

# Browser suites — need a server for the built site:
#   npm run build && node tests/static-server.mjs build 4321
npm run test:studio    # 26 assertions: cross-filter moves the other views, publish, print layout
npm run test:gallery   # 10 assertions: every component on /gallery actually rendered
npm run test:flint:ui  # 12 checks: every chart painted, in the project's hues, on the right surface
```

The tests are execution-based rather than snapshot-based: generated SQL is run
against real data and compared to an independently written control query, so
they fail when a number changes, not when formatting does.

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

| Path | Upstream | Pinned to | Contains |
|---|---|---|---|
| `vendor/evidence` | [evidence-dev/evidence](https://github.com/evidence-dev/evidence) | `main` | core-components, CLI, all bundled connectors |
| `vendor/evidence-datasources` | [evidence-dev/datasources](https://github.com/evidence-dev/datasources) | `main` | Google Sheets + InfluxDB connectors |
| `vendor/cube` | [PackMaaan/cube](https://github.com/PackMaaan/cube) | `master` | the semantic layer behind `/noodle-cube` |
| `vendor/duckdb` | [duckdb/duckdb](https://github.com/duckdb/duckdb) | **`v1.4.2`** | engine source, for extension work |

The first two cover **all 15** packages in `package.json`.

`vendor/duckdb` is pinned to the tag matching the engine actually in use
(`@duckdb/node-api` 1.4.2-r.1 reports `v1.4.2`) rather than to `main`, so
anything built against it links against the same version that runs. It is a
shallow checkout (~400 MB) and nothing in the app depends on it — it exists for
the `read_openzl()` extension sketched in
[docs/openzl-evaluation.md](docs/openzl-evaluation.md), which is a design, not a
commitment.

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
