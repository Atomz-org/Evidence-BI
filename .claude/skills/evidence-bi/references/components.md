# Evidence component cookbook

Verified against the installed `@evidence-dev/core-components` 5.4.x /
`@evidence-dev/evidence` 40.x in this project. `node_modules` is what actually
runs, but the **readable** source of truth is the pinned upstream checkout at
[`vendor/evidence/packages/ui/core-components/src/`](../../../../vendor/evidence)
— same versions, unminified, with stories and tests. Read props there
(`git -C vendor/evidence log` for history); confirm against `node_modules` if
the two ever drift (`./scripts/sync-evidence-upstream.sh --check`). Every
snippet below uses props that exist in this version.

## Queries

### Inline (page) queries

````markdown
```sql orders_by_week
select date_trunc('week', metric_time) as week, sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}' and '${inputs.date_range.end}'
group by 1 order by 1
```
````

- `${other_query}` chains queries (DuckDB WASM view composition).
- `${inputs.<name>.<field>}` interpolates input state; `${params.<param>}`
  interpolates the URL parameter on templated pages.

### External queries (`queries/` directory) — the semantic layer lives here

Frontmatter loads `.sql` files from `queries/`:

```yaml
---
title: Revenue
queries:
  - metrics/revenue.sql
---
```

**The query id is the path with `/` → `_`, minus `.sql`** — so
`metrics/revenue.sql` is referenced as `{metrics_revenue}` / `from ${metrics_revenue}`.
Keep external queries free of `${inputs...}` — they are the shared, canonical
definitions; pages filter them with inline queries.

## KPI row

```markdown
<Grid cols=4>
  <BigValue data={kpi} value=revenue title="Revenue" fmt=usd0k
    comparison=revenue_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=order_count title="Orders" fmt=num0
    comparison=orders_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=average_order_value title="Avg Order Value" fmt=usd2/>
  <BigValue data={kpi} value=emea_share title="EMEA Revenue Share" fmt=pct1/>
</Grid>
```

Facts that matter (verified in source):

- **BigValue displays row 0.** For a time-series KPI (sparkline), `order by
  metric_time desc` so the current value is first; the sparkline plots by date
  value, so descending order draws correctly.
- `comparison=` is a *column* (computed per-row in SQL, e.g. growth vs previous
  period); `comparisonDelta=true` (default) renders the ▲/▼ arrow with
  positive/negative theme colors; set `downIsGood=true` for cost-like metrics.
- `sparkline=<date_column>` adds the trend; `sparklineType` = line | area | bar.
- `link='/regions/EMEA'` makes the whole tile a drill link.
- Never ship a BigValue with neither `comparison` nor `sparkline`.

Cumulative-metric KPI (value = latest, shape = trajectory):

```markdown
<BigValue data={trailing_28d} value=revenue_trailing_28d title="Revenue, trailing 28d"
  fmt=usd0k sparkline=metric_time sparklineType=area/>
```

## Filter row

```markdown
```sql date_bounds
select min(metric_time) as start_date, max(metric_time) as end_date from ${metrics_revenue}
```

```sql region_list
select distinct region from ${metrics_revenue} order by region
```

<DateRange name=date_range data={date_bounds} dates=start_date defaultValue="All Time"/>
<Dropdown name=region data={region_list} value=region multiple=true
  selectAllByDefault=true title="Region"/>
```

- DateRange presets available: `Last 30 Days`, `Last 90 Days`, `Last Month`,
  `Month to Date`, `Year to Date`, `Last Year`, `All Time`.
- Consume: `between '${inputs.date_range.start}' and '${inputs.date_range.end}'`.
- Multi-select Dropdown consumes as `where region in ${inputs.region.value}` —
  no quotes, Evidence serializes the tuple.
- Single-select with an All option:
  `<Dropdown name=status><DropdownOption value="%" valueLabel="All"/></Dropdown>`
  consumed as `like '${inputs.status.value}'`.

**`defaultValue="All Time"` silently kills every previous-period comparison** —
the prior window falls entirely before the data, so `revenue_growth` is null and
the delta renders blank. Default to a bounded preset (`Last 30 Days`) on any page
whose KPIs carry `comparison=`.

### ButtonGroup and Slider — inputs that reshape the query

```markdown
<ButtonGroup name=grain title="Grain">
  <ButtonGroupItem valueLabel="Day" value="day"/>
  <ButtonGroupItem valueLabel="Week" value="week" default/>
  <ButtonGroupItem valueLabel="Month" value="month"/>
</ButtonGroup>

<Slider name=target title="Daily target" min=1000 max=10000 step=250
  defaultValue=6000 fmt=usd0 showInput=true/>
```

- Both write a **bare scalar** to the input store — consume as `'${inputs.grain}'`
  (quoted, it is a string) and `${inputs.target}` (unquoted, it is a number).
  Neither takes `.value`; that is Dropdown-only.
- `default` on a `ButtonGroupItem` is a bare attribute, not `default=true`.
- A grain button rewrites `date_trunc('${inputs.grain}', metric_time)`; a slider
  feeds `<ReferenceLine y={inputs.target}/>` directly in markup, where plain JS
  works: `y={inputs.target * (inputs.grain === 'week' ? 7 : 1)}`.
- `<ButtonGroup preset=dates/>` ships `Week | Month | Year` as `7 days` /
  `1 month` / `1 year` — the only built-in preset.

### DimensionGrid — cross-filter with no SQL

```markdown
<DimensionGrid data={cut_source} metric="sum(revenue)" metricLabel="Revenue"
  name=cut fmt=usd0k limit=6/>
```

Feed it a query of **categorical columns plus the measure**; it renders a chip
per value per dimension and writes a ready-made predicate to `inputs.<name>`,
consumed as `where ${inputs.cut}` (no quotes — it is SQL). With nothing selected
it emits `true`, so the query is always valid. Selections combine with `AND`.

## Charts

```markdown
<LineChart data={trend} x=metric_time y=revenue yFmt=usd0k
  title="Daily revenue" subtitle="Excludes cancelled orders"/>

<BarChart data={weekly} x=week y=revenue series=region type=stacked yFmt=usd0k
  title="Weekly revenue by region"
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a','Guest checkout':'#eda100'}}/>
```

- `seriesColors` (object: series → hex) pins hue to entity so filters never
  repaint survivors. Use palette hexes only, in slot order.
- Horizontal bars for long labels: `swapXY=true`.
- Annotations: `<ReferenceLine y=1000 label="Target"/>` or
  `<ReferenceArea xMin='2026-07-01' xMax='2026-07-15'/>` as children of the chart.
- `chartAreaHeight=<px>` when the default is too short for a full-width trend.
- No `y2` with a different unit. Ever.

Annotations take theme status colours by name, and `hideValue` suppresses the
number in the label:

```markdown
<ReferenceLine y=7500 label="Target" hideValue labelPosition=aboveStart color=positive/>
<ReferencePoint x='2026-07-04' y=6590 label="Launch" labelPosition=bottom color=negative/>
```

### Beyond the four core forms

Each of these answers a job the line/bar/table trio cannot. Props verified
against 5.4.x — note that several use **their own column props**, not `x`/`y`.

```markdown
<AreaChart data={mix} x=period y=revenue series=region type=stacked100
  title="Revenue mix"/>                                 <!-- share, not level -->

<Heatmap data={grid} x=weekday y=region value=revenue xSort=dow
  valueFmt=usd0k cellHeight=34/>                        <!-- 1 measure, 2 dimensions -->

<Histogram data={daily} x=revenue xFmt=usd0k/>          <!-- shape of one measure -->

<BoxPlot data={spread} name=region min=low intervalBottom=q1
  midpoint=median_day intervalTop=q3 max=high swapXY=true/>

<BubbleChart data={by_country} x=order_count y=average_order_value
  size=revenue series=region sizeFmt=usd0k/>            <!-- 3 measures, no 2nd axis -->

<SankeyDiagram data={flow} sourceCol=source targetCol=target valueCol=value
  valueFmt=usd0k linkColor=source nodeLabels=full/>     <!-- allocation across 2 dimensions -->
```

- **`Heatmap` sorts categories by a companion column** — `xSort=dow` with a
  numeric `dow` in the query, or weekdays come out alphabetical.
- **`BoxPlot` does not compute quantiles.** Pass pre-computed columns
  (`quantile_cont(x, 0.25)` in DuckDB) and map them to
  `min` / `intervalBottom` / `midpoint` / `intervalTop` / `max`.
- **`SankeyDiagram` uses `sourceCol` / `targetCol` / `valueCol`**, not `x`/`y`.
  `linkColor=source` colours flows by their origin; `orient=vertical` flips it.
- `FunnelChart` takes `nameCol` / `valueCol` — use it only for genuine stage
  progression. Mutually exclusive states (order statuses) are **not** a funnel;
  that is a Sankey or a bar.
- `CalendarHeatmap` (`date=` + `value=`) needs a year or more of daily data to
  read well — on a six-week window it is mostly empty cells.

## DataTable

```markdown
<DataTable data={by_region} link=region_url search=false totalRow=true>
  <Column id=region title="Region"/>
  <Column id=revenue fmt=usd0 title="Revenue"/>
  <Column id=order_count fmt=num0 title="Orders"/>
  <Column id=average_order_value fmt=usd2 title="AOV"/>
  <Column id=revenue_growth fmt=pct1 contentType=delta title="vs prev period"/>
</DataTable>
```

- `link=<column>` makes rows clickable (build the URL in SQL:
  `'/regions/' || region as region_url`); the URL column is auto-hidden when
  other columns are declared.
- `contentType=delta` → arrow + positive/negative color (add `downIsGood=true`
  where falling is good). `contentType=colorscale scaleColor=blue` → sequential
  shading (magnitude job only).
- `search=true rows=25` for lookup tables; `totalRow=true` for finance tables;
  `groupBy=` + `subtotals=true` for grouped finance views;
  `downloadable=true` for the export button.

Cell content types (`contentType=` on `<Column>`):

| Value | Renders | Needs |
|---|---|---|
| `delta` | ▲/▼ + signed value | a **change**, not a level — `downIsGood=true` for costs |
| `colorscale` | sequential shading | `scaleColor=blue`; magnitude only |
| `bar` | in-cell bar | `barColor=` optional |
| `sparkline` / `sparkarea` / `sparkbar` | in-cell mini chart | `sparkX=` `sparkY=` |
| `link` / `image` | anchor / img | `linkLabel=`, `openInNewTab=` |

A sparkline column needs a **list of structs** in that cell, keyed to match
`sparkX` / `sparkY`:

```sql
select region,
       array_agg({'week': week, 'revenue': revenue} order by week) as trend
from weekly group by 1
```

```markdown
<Column id=trend title="Weekly" contentType=sparkline sparkX=week sparkY=revenue/>
```

`npm run build` prints `[!] Evidence does not support DuckDB Struct or Array`
for that column — it comes from the query **size-estimator**, not the renderer,
and the sparkline works. Grain matters: aggregate the array at the same grain as
the row, or every row in a group shows the same trend.

## Drill-down (templated pages)

`pages/regions/[region].md`:

```markdown
---
title: Region detail
queries:
  - metrics/revenue.sql
---

# {params.region}

```sql region_trend
select metric_time, sum(revenue) as revenue
from ${metrics_revenue}
where region = '${params.region}'
group by 1 order by 1
```
```

Link into it from any `DataTable link=` column or `BigValue link=`. This is the
Looker drill-field / Power BI drill-through equivalent — but versioned and
reviewable.

## Layout & narrative

- `<Grid cols=2 gapSize=md>…</Grid>` for breakdown pairs; `cols=4` for KPI rows.
- `<Tabs><Tab label="Trend">…</Tab><Tab label="Table">…</Tab></Tabs>` when a
  chart and its table view compete for space. This is how "the table is always
  reachable" costs no vertical space.
- `<Details title="How this metric is defined">…</Details>` for metric
  definitions pulled from dbt YAML descriptions — keep dashboards self-documenting.
- `<Accordion><AccordionItem title="…">…</AccordionItem></Accordion>` when
  several such disclosures belong together (definition / compiled SQL / page).
- `<Alert status=warning>…</Alert>` for data-quality caveats; `<Modal
  title="…" buttonText="…">…</Modal>` for the long-form aside a dashboard
  shouldn't carry inline.
- `<DownloadData data={q} text="Download"/>` beside any table someone will ask
  for in a spreadsheet; `<LastRefreshed prefix="Sources built"/>` in the header.
- `<LinkButton url='/metrics'>Metric dictionary</LinkButton>` for cross-page
  navigation.

### Numbers inside prose

```markdown
Revenue reached <Value data={kpi} column=revenue fmt=usd0k/> across
<Value data={kpi} column=order_count fmt=num0/> orders.
```

`<Value>` takes `column=` (not `value=`), defaults to `row=0`, and accepts the
same `fmt` strings as charts. `<Delta data={kpi} column=revenue_growth fmt=pct1
chip=true/>` renders an inline arrow chip. Interpolated inputs work in titles
too: `title="Revenue by {inputs.grain}"`.

A commentary sentence built from `<Value>` recomputes with the data — it is the
cheapest defence against a deck that goes stale between the build and the
meeting.

## Format strings (pick once per measure, reuse everywhere)

| Measure | fmt | Renders |
|---|---|---|
| Revenue (charts, KPIs) | `usd0k` | $210k |
| Revenue (tables, exact) | `usd0` | $198,757 |
| AOV | `usd2` | $404.79 |
| Counts | `num0` | 492 |
| Shares / growth | `pct1` | 68.9% |
| Dates (daily) | `'mmm d'` | Jun 20 |
| Dates (monthly) | `'mmm yyyy'` | Jun 2026 |

`pct` formats expect fractions (0.689 → 68.9%) — compute ratios as fractions in
SQL, not pre-multiplied by 100.
