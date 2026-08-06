# Evidence component cookbook

Verified against the installed `@evidence-dev/core-components` 5.4.x /
`@evidence-dev/evidence` 40.x in this project (`node_modules` is ground truth;
upstream source: github.com/evidence-dev/evidence). Every snippet below uses
props that exist in this version.

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
  `groupBy=` + `subtotals=true` for grouped finance views.

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
  chart and its table view compete for space.
- `<Details title="How this metric is defined">…</Details>` for metric
  definitions pulled from dbt YAML descriptions — keep dashboards self-documenting.
- `<Alert status=warning>…</Alert>` for data-quality caveats.

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
