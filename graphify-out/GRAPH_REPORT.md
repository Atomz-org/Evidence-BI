# Graph Report — Evidence BI

Generated from `graphify-out/graph.json` by `scripts/graphify-lineage.py`,
after lineage injection — so every figure below describes the graph as shipped.

## Summary
- 1172 nodes · 1770 edges · 82 communities
- 129 source files referenced
- Extraction: 1742 EXTRACTED · 28 INFERRED
- Built from commit: `86ffe12d23a44a3539105e8a181f6ec13ba3ed44`

## Edges by relation
- `contains` — 924
- `calls` — 330
- `imports` — 102
- `imports_from` — 97
- `uses_column` — 93
- `has_column` — 65
- `indirect_call` — 27
- `references` — 27
- `references_query` — 27
- `loads_query` — 23
- `derives_from` — 15
- `dynamic_import` — 13
- `defines` — 10
- `derived_from` — 7
- `extends` — 7
- `cites` — 1
- `re_exports` — 1
- `writes` — 1

## God Nodes (most connected — the core abstractions)
1. `Canvas.svelte` — 68 edges
2. `dashboard.js` — 45 edges
3. `Studio.svelte` — 41 edges
4. `showcase.md` — 41 edges
5. `RillExplore.svelte` — 35 edges
6. `scripts` — 35 edges
7. `Noodle.svelte` — 34 edges
8. `Metric Dictionary` — 33 edges
9. `Revenue Overview` — 31 edges
10. `metrics.js` — 31 edges

## Communities (82 total)

### Community 4 — "Canvas.svelte"
Nodes (93): Canvas.svelte, D3_SUBSET, GRAIN_ORDER, RILL, TOTAL, applyD3(), axisFormatter(), boundsSql() (+83 more)

### Community 0 — "dependencies"
Nodes (37): @evidence-dev/bigquery, @evidence-dev/connector-gsheets, @evidence-dev/core-components, @evidence-dev/csv, @evidence-dev/databricks, @evidence-dev/duckdb, @evidence-dev/evidence, @evidence-dev/motherduck (+11 more)

### Community 3 — "scripts"
Nodes (35): adbc:drivers, bench:layout, bench:openzl, build, build:strict, cube:down, cube:up, dashboard:audit (+27 more)

### Community 8 — "Studio.svelte"
Nodes (35): Studio.svelte, addPageFilter(), addTile(), applyFilter(), autoBuild(), bestCategory(), categoryRank(), chooseFilterField() (+27 more)

### Community 10 — "runner.js"
Nodes (32): CUBE_GRANULARITIES, OPERATOR_MAP, TABLE_CALCS, TYPE_MAP, applyTableCalcs(), calcFormat(), catalogFromCubeMeta(), checkJoinable() (+24 more)

### Community 16 — "Page audit rules"
Nodes (31): Chart audit rules, Custom components, Data tables, Everything else, one line each, Filters, Layouts, Maps, Page audit rules (+23 more)

### Community 22 — "Recipes — working `<FlintChart>` blocks"
Nodes (30): A chart in a fixed box, Actual against target, Anti-patterns, Change over time, Checking your own chart, Colour is not Flint's, Composition over time, Debugging a chart while you build it (+21 more)

### Community 23 — "dashboard.js"
Nodes (28): DASHBOARD_VERSION, TILE_HEIGHTS, TILE_WIDTHS, __resetTileCounter(), applySubstitution(), dashboard.js, dashboardToMarkdown(), describeFilter() (+20 more)

### Community 24 — "spec.js"
Nodes (28): ALL_SHELVES, COMPONENT_FOR_MARK, LIST_SHELVES, SINGLE_SHELVES, __resetPillCounter(), aggLabel(), allPills(), calcLabel() (+20 more)

### Community 25 — "build-rill-model.mjs"
Nodes (28): EXTENSION_COMPONENTS, FLINT_TEMPLATE, FORMAT_PRESETS, GRAINS, GRAIN_SEMANTIC_TYPE, OUT, RILL, RILL_COMPONENTS (+20 more)

### Community 26 — "bench-openzl.mjs"
Nodes (27): MB(), QUERY(), QUERY_COLUMNS, ROOT, ROWS, WORK, ZLI, arg() (+19 more)

### Community 27 — "index.cjs"
Nodes (26): ARROW, COMMON, DUCKDB_BACKED, FLAVORS, arrow-types.cjs, arrowTypeToEvidence(), assertNoDuckdbConflict(), columnTypesFromSchema() (+18 more)

### Community 28 — "t-dashboard.mjs"
Nodes (25): ROOT, asReport, byStatus, check(), checks, controlRows, crossed, dash (+17 more)

### Community 29 — "RillExplore.svelte"
Nodes (22): RillExplore.svelte, baseOption(), boardMax(), boardTotal(), boards, chartOption(), clearFilters(), detail (+14 more)

### Community 30 — "compile.js"
Nodes (21): AGGREGATIONS, DATE_PARTS, FILTER_OPS, aggregateExpr(), buildOrderBy(), columnRef(), compile(), compile.js (+13 more)

### Community 9 — "Revenue Overview"
Nodes (20): 1 · Executive summary, 1.1 Period-on-period movement, 10 · Why you can trust the numbers, 2 · One filter row drives every chart below, 2 · Trend and mix, 3 · Composition and concentration, 3 · KPIs that carry their own comparison, 4 · A trend that changes grain on click, and a target you can drag (+12 more)

### Community 31 — "adbc/package.json"
Nodes (18): @apache-arrow/adbc-driver-manager, @evidence-dev/db-commons, adbc/package.json, arrow-types.cjs, datasources, dependencies, description, drivers.cjs (+8 more)

### Community 32 — "theme-bridge.js"
Nodes (18): CATEGORICAL, CHROME, ECHARTS_DEFAULTS, NEEDS_RELIEF, SEQUENTIAL, STATUS, applyProjectTheme(), auditOption() (+10 more)

### Community 33 — "dashboard-audit.mjs"
Nodes (18): MEASURE_WORDS, ROOT, RULES, allowedColours(), argv, asJson, auditPage(), byPage (+10 more)

### Community 34 — "ADBC sources"
Nodes (17): ADBC sources, Cube as noodle's semantic layer, Cube's SQL API does not work through the postgres driver, Flavors, Model layout, Option names that are not guessable, Running it locally, Setup (+9 more)

### Community 35 — "t-rill.mjs"
Nodes (17): ROOT, TEMPLATE, assert(), bounds, catalog, check(), controlMeasures(), controlWhere() (+9 more)

### Community 36 — "t-canvas.mjs"
Nodes (16): ROOT, TEMPLATE, assert(), bounds, check(), failures, filters, g (+8 more)

### Community 37 — "t-screen.mjs"
Nodes (15): ROOT, TEMPLATE, WINDOWS, assert(), check(), close(), failures, manifest (+7 more)

### Community 38 — "Noodle.svelte"
Nodes (14): @evidence-dev/universal-sql/client-duckdb, Noodle.svelte, SHELF_LABEL, active, addFilter(), chosen, copyExport(), onDragStart() (+6 more)

### Community 39 — "Deploying on a 2 GB server"
Nodes (14): Build plane — transient, exclusive, ~2 GB, Deploying on a 2 GB server, Disk, Install, Running Rill for real, Running the compressed build locally, Serve plane — always on, ~500 MB, The design (+6 more)

### Community 40 — "t-flint.mjs"
Nodes (14): ECHARTS_STOCK, ROOT, TEMPLATE, TYPES, assert(), axisOf(), boardLine(), boot() (+6 more)

### Community 41 — "flint/export.js"
Nodes (13): GOOGLE_SHEETS_NEW, RFC-4180, cellText(), columnsOf(), copyText(), downloadText(), flint/export.js, quote() (+5 more)

### Community 42 — "layout-fit.js"
Nodes (13): FIT, TOKEN_WIDTHS, bandHeight(), count(), estimateWidth(), first(), fitToBox(), labelsOf() (+5 more)

### Community 43 — "Should Evidence read OpenZL instead of parquet?"
Nodes (13): 1. Cluster on write — worth 5.6x, measured, 2. Raise the zstd level — worth 6% for free, 3. Revisit OpenZL if it ships chunk-addressable frames, A number worth distrusting, Compression, measured fairly, Reproducing, Should Evidence read OpenZL instead of parquet?, The version that would actually work (+5 more)

### Community 44 — "t-cube.mjs"
Nodes (13): F(), ROOT, TEMPLATE, boot(), catalog, check(), checks, client (+5 more)

### Community 45 — "t-adbc.mjs"
Nodes (13): ROOT, adbc, counts, lakeDir, live(), reachable(), reachesTheWire(), record() (+5 more)

### Community 46 — "t-compile.mjs"
Nodes (13): ESC, ROOT, cell(), check(), checks, collide, datasetJson, notebook (+5 more)

### Community 47 — "t-cubesql.mjs"
Nodes (13): F(), ROOT, agree, build(), cases, catalog, client, pg (+5 more)

### Community 48 — "The cycle"
Nodes (12): 0. Frame — one sentence, before any SQL, 1. Draft, 2. Score, 3. Critique — what the audit cannot see, 4. Fix one thing, 5. Stop, Anti-patterns of the loop itself, Reference files (+4 more)

### Community 49 — "By the job the chart does"
Nodes (12): By the job the chart does, Change over time, Chart catalog — the 37 ECharts templates, Composition, Correlation and relationship, Distribution, Faceting, Financial and indicator (+4 more)

### Community 50 — "Tile.svelte"
Nodes (12): #each(), $app/environment, @evidence-dev/component-utilities/formatting, ExportMenu.svelte, FlintChart.svelte, LiveQuery.svelte, Tile.svelte, applyHighlight() (+4 more)

### Community 51 — "apply-notebook-core.mjs"
Nodes (12): CHECK_ONLY, INSTALLED, ROOT, TARGETS, VENDOR, apply-notebook-core.mjs, copies, exists() (+4 more)

### Community 52 — "cdp.mjs"
Nodes (12): cdp.mjs, check(), checks, errors, freePort(), openPage(), sleep(), state() (+2 more)

### Community 53 — "t-noodle.mjs"
Nodes (12): F(), ROOT, check(), checks, exec(), joined, lodSpec, near() (+4 more)

### Community 5 — "Evidence BI Skill"
Nodes (11): Component Cookbook, Design Principles, Evidence BI README, Evidence BI Skill, Evidence Configuration, dbt Semantic Integration, dbt Semantic Layer Contract, dbt Semantic Source (+2 more)

### Community 54 — "bench-layout.mjs"
Nodes (11): LAYOUTS, ROOT, ROWS, WORK, arg(), bench-layout.mjs, best, one() (+3 more)

### Community 55 — "t-flint-ui.mjs"
Nodes (11): DARK, LIGHT, STOCK, check(), checks, crashes, darkCrashes, failed (+3 more)

### Community 1 — "Enterprise reporting standard"
Nodes (10): Comparatives, Enterprise reporting standard, Evidence gotcha: fenced code blocks become queries, Materiality, Number conventions, Print and export, Report page skeleton, What a report carries that a dashboard doesn't (+2 more)

### Community 56 — "A worked example — 76/100 to clean"
Nodes (10): A worked example — 76/100 to clean, Critique, Pass 1 — the draft, Pass 2 — the frame, Pass 3 — wrong numbers, then missing comparisons, Pass 4 — the remaining findings, Pass 5 — the exit check, Score (+2 more)

### Community 57 — "catalog.js"
Nodes (10): TYPE_GROUPS, buildCatalog(), catalog.js, classifyType(), fieldsFromDescribe(), fromClause(), humanize(), inferFormat() (+2 more)

### Community 58 — "encode.js"
Nodes (10): axisLabeller(), buildChartOption(), buildSeriesData(), encode.js, escapeHtml(), heatmapOption(), label(), onClick() (+2 more)

### Community 59 — "t-livequery-ui.mjs"
Nodes (10): act(), check(), checks, crashes, failed, panel(), resetPanel(), runPanel() (+2 more)

### Community 60 — "Semantic types — the 44 registered names"
Nodes (9): Annotations, Categories and ordering, Measures, Picking one, Place, Semantic types — the 44 registered names, Time, What a type decides (+1 more)

### Community 61 — "them. Same setting the studio, gallery and noodle pages use."
Nodes (9): A twelve-column grid inside Evidence's default 736px prose column gives a, The three things worth looking at closely, What is on this page, Where this board stops, Why one board rather than five pages, canvas.md, half-width tile 344px, and a horizontal bar chart 190px of plot after its, labels. The layout file says twelve columns; the page has to actually have (+1 more)

### Community 62 — "t-canvas-ui.mjs"
Nodes (8): check(), checks, crashes, failed, flintWarnings, moved, read(), t-canvas-ui.mjs

### Community 63 — "package.json"
Nodes (7): engines, name, node, npm, package.json, type, version

### Community 64 — "A canvas needs the room; the prose column is for the notes underneath it."
Nodes (7): A canvas needs the room; the prose column is for the notes underneath it., Dashboard or report, How it works, Saving, and what a save contains, The part that usually goes wrong, This is still exploration, studio.md

### Community 65 — "Rill as a declarative dashboard layer"
Nodes (7): Rill as a declarative dashboard layer, Running it, Two resolvers, one model, Verifying, What is not implemented, What the generator enforces, rill/README.md

### Community 66 — "t-cube-ui.mjs"
Nodes (7): MONTHS, check(), checks, errors, sleep(), t-cube-ui.mjs, truth

### Community 67 — "t-notebook-ui.mjs"
Nodes (7): check(), checks, choose(), crashes, failed, read(), t-notebook-ui.mjs

### Community 68 — "t-rill-ui.mjs"
Nodes (7): check(), checks, clickText(), crashes, failed, read(), t-rill-ui.mjs

### Community 69 — "t-serialize.mjs"
Nodes (7): LS, PS, ROOT, forbidden, lit, ok(), t-serialize.mjs

### Community 70 — "t-studio-ui.mjs"
Nodes (7): check(), checks, errors, numeric(), sleep(), snapshot(), t-studio-ui.mjs

### Community 71 — "showme.js"
Nodes (6): MARKS, blockedReason(), recommend(), resolveMark(), showme.js, sort()

### Community 72 — "build.sh"
Nodes (6): build.sh, build.sh script, cleanup(), have(), log(), svc()

### Community 73 — "rill.md"
Nodes (6): The same measures, on a worksheet, The three things Rill gets right, kept, What `valid_percent_of_total` is doing, What this page is, Where it deliberately differs, rill.md

### Community 74 — "browserslist"
Nodes (5): > 0.5%, Firefox ESR, browserslist, last 2 versions, not dead

### Community 75 — "overrides"
Nodes (5): axios, jsonwebtoken, overrides, sqlite3, trim@<0.0.3

### Community 76 — "A workbench, not a document: three panels and a chart need the whole width."
Nodes (5): A workbench, not a document: three panels and a chart need the whole width., The relationship layer, This is exploration, not governance, What the shelves actually do, noodle.md

### Community 77 — "static-server.mjs"
Nodes (5): PORT, ROOT, TYPES, proxyToCube(), static-server.mjs

### Community 2 — "5 · Basis of preparation"
Nodes (4): 5 · Basis of preparation, 5.1 Metric register, 5.2 Data lineage, 5.3 Presentation standards

### Community 11 — "graphify-lineage.py"
Nodes (4): col_id(), file_node_id(), graphify-lineage.py, main()

### Community 78 — "install.sh"
Nodes (4): DEBIAN_FRONTEND, install.sh, install.sh script, log()

### Community 79 — "noodle-cube.md"
Nodes (4): The same model, three ways, What Cube contributes, Where this sits, noodle-cube.md

### Community 80 — "cube/up.sh"
Nodes (3): cube/up.sh, run_cube(), up.sh script

### Community 81 — "cube/cube.js"
Nodes (3): REPO, cube/cube.js, path

### Community 82 — "seed.sh"
Nodes (3): ch(), seed.sh, seed.sh script

### Community 83 — "precompress.sh"
Nodes (3): have(), precompress.sh, precompress.sh script

### Community 84 — "publish.sh"
Nodes (3): log(), publish.sh, publish.sh script

### Community 85 — "t-cube-tz.mjs"
Nodes (3): ROOT, ZONES, t-cube-tz.mjs

### Community 86 — "F"
Nodes (3): F(), statusSpec(), trendSpec()

### Community 12 — "sync-evidence-upstream.sh"
Nodes (2): sync-evidence-upstream.sh, sync-evidence-upstream.sh script

### Community 87 — "serve-local.sh"
Nodes (2): serve-local.sh, serve-local.sh script

### Community 88 — "zram-setup.sh"
Nodes (2): zram-setup.sh, zram-setup.sh script

### Community 89 — "rill/up.sh"
Nodes (2): rill/up.sh, up.sh script

### Community 90 — "{ project, models, metricsViews, explores, canvases, sourceHash }"
Nodes (1): { project, models, metricsViews, explores, canvases, sourceHash }

### Community 91 — "flint-chart"
Nodes (1): flint-chart

## Hyperedges (group relationships)
- **Design System Enforcement** — evidence_config, skill_design, skill_components, pages_index [EXTRACTED 0.90]
- **Design System Enforcement** — evidence_config, skill_design_principles, skill_components [EXTRACTED 1.00]

## Knowledge Gaps
- **625 node(s) with ≤1 connection:** `#each()`, `0. Frame — one sentence, before any SQL`, `1. Cluster on write — worth 5.6x, measured`, `1. Draft`, `1.1 Period-on-period movement` (+620 more)
- **80 node(s) outside every community** (80 of them injected lineage). Clustering runs during the `/graphify` rebuild, before lineage injection, so a column or query node minted here is only placed in a community once the next full rebuild sees it.
