---
title: Order Revenue Performance
description: Management report on governed dbt semantic-layer metrics. Report RPT-REV-001.
queries:
  - metrics/revenue.sql
  - metrics/order_count.sql
  - metrics/average_order_value.sql
  - metrics/revenue_trailing_28d.sql
  - metrics/revenue_by_dimensions.sql
---

```sql date_bounds
-- Both ends in ONE column — DateRange runs min()/max() over the column named by
-- dates=, so min and max in separate columns leaves it a single value to work
-- from and every relative default anchors to the start of the data.
select min(metric_time) as metric_time from ${metrics_revenue}
union all
select max(metric_time) from ${metrics_revenue}
```

```sql region_list
select distinct region from ${metrics_revenue} order by region
```

```sql control
select
    '${inputs.date_range.start}'::date as period_start,
    '${inputs.date_range.end}'::date as period_end,
    max(metric_time) as data_as_of
from ${metrics_average_order_value}
where metric_time <= '${inputs.date_range.end}'::date
```

<Details title="Report control">

| | |
|---|---|
| **Report ID** | RPT-REV-001 · v1.2 |
| **Reporting period** | <Value data={control} column=period_start fmt=rptdate/> to <Value data={control} column=period_end fmt=rptdate/> |
| **Data as of** | <Value data={control} column=data_as_of fmt=rptdate/> |
| **Currency** | USD |
| **Owner** | Analytics Engineering |
| **Source of truth** | `models/semantic/_metrics.yml` (dbt semantic layer) |
| **Refresh cadence** | On dbt build — <LastRefreshed prefix="sources built"/> |
| **Classification** | Internal · demonstration data |

</Details>

<DateRange name=date_range data={date_bounds} dates=metric_time defaultValue="Last 30 Days"/>
<Dropdown name=region data={region_list} value=region multiple=true selectAllByDefault=true title="Region"/>
<ButtonGroup name=grain title="Grain">
  <ButtonGroupItem valueLabel="Day" value="day"/>
  <ButtonGroupItem valueLabel="Week" value="week" default/>
  <ButtonGroupItem valueLabel="Month" value="month"/>
</ButtonGroup>

## 1 · Executive summary

```sql summary
with cur as (
    select sum(revenue) as revenue, sum(order_count) as order_count
    from ${metrics_average_order_value}
    where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
      and region in ${inputs.region.value}
),
prev as (
    select sum(revenue) as revenue, sum(order_count) as order_count
    from ${metrics_average_order_value}
    where metric_time
        between '${inputs.date_range.start}'::date
                - (('${inputs.date_range.end}'::date - '${inputs.date_range.start}'::date) + 1)::int
            and '${inputs.date_range.start}'::date - 1
      and region in ${inputs.region.value}
)
select
    cur.revenue,
    cur.order_count,
    cur.revenue / nullif(cur.order_count, 0) as average_order_value,
    (cur.revenue - prev.revenue) / nullif(prev.revenue, 0) as revenue_growth,
    (cur.order_count - prev.order_count) / nullif(prev.order_count, 0) as orders_growth,
    (cur.revenue / nullif(cur.order_count, 0) - prev.revenue / nullif(prev.order_count, 0))
        / nullif(prev.revenue / nullif(prev.order_count, 0), 0) as aov_growth
from cur, prev
```

```sql trailing
select metric_time, revenue_trailing_28d
from ${metrics_revenue_trailing_28d}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
order by metric_time desc
```

<Grid cols=4>
  <BigValue data={summary} value=revenue title="Revenue" fmt=usdacc
    comparison=revenue_growth comparisonFmt=pctacc comparisonTitle="vs prior period"/>
  <BigValue data={summary} value=order_count title="Orders" fmt=numacc
    comparison=orders_growth comparisonFmt=pctacc comparisonTitle="vs prior period"/>
  <BigValue data={summary} value=average_order_value title="Average order value" fmt=usdacc2
    comparison=aov_growth comparisonFmt=pctacc comparisonTitle="vs prior period"/>
  <BigValue data={trailing} value=revenue_trailing_28d title="Revenue, trailing 28d"
    fmt=usdacc sparkline=metric_time sparklineType=area
    description="Cumulative metric — compiled without dimension columns, so it covers all regions regardless of the region filter."/>
</Grid>

### 1.1 Period-on-period movement

Comparatives are **queried, not derived** — the prior window is the selected range shifted
back by its own length. Adverse variances are shown in parentheses.

```sql movement
with cur as (
    select sum(revenue) as revenue, sum(order_count)::double as order_count
    from ${metrics_average_order_value}
    where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
      and region in ${inputs.region.value}
),
prev as (
    select sum(revenue) as revenue, sum(order_count)::double as order_count
    from ${metrics_average_order_value}
    where metric_time
        between '${inputs.date_range.start}'::date
                - (('${inputs.date_range.end}'::date - '${inputs.date_range.start}'::date) + 1)::int
            and '${inputs.date_range.start}'::date - 1
      and region in ${inputs.region.value}
)
select 1 as seq, 'Revenue' as measure,
       cur.revenue::double as current_period, prev.revenue::double as prior_period
from cur, prev
union all
select 2, 'Orders', cur.order_count, prev.order_count from cur, prev
union all
select 3, 'Average order value',
       cur.revenue / nullif(cur.order_count, 0),
       prev.revenue / nullif(prev.order_count, 0)
from cur, prev
order by seq
```

```sql movement_final
select
    measure,
    current_period,
    prior_period,
    current_period - prior_period as movement,
    (current_period - prior_period) / nullif(prior_period, 0) as variance
from ${movement}
order by seq
```

<DataTable data={movement_final}>
  <Column id=measure title="Measure"/>
  <Column id=current_period title="Current period" fmt=numacc/>
  <Column id=prior_period title="Prior period" fmt=numacc/>
  <Column id=movement title="Movement" fmt=numacc redNegatives/>
  <Column id=variance title="Variance" fmt=pctacc contentType=delta/>
</DataTable>

<Alert status=info>

Selecting **All Time** blanks these columns by design: there is no earlier period of equal
length to compare against, and an empty variance is the honest answer.

</Alert>

<PageBreak/>

## 2 · Trend and mix

```sql trend
select
    date_trunc('${inputs.grain}', metric_time) as period,
    sum(revenue) as revenue,
    sum(order_count) as order_count,
    sum(revenue) / nullif(sum(order_count), 0) as average_order_value
from ${metrics_average_order_value}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1
order by 1
```

```sql trend_mix
select
    date_trunc('${inputs.grain}', metric_time) as period,
    region,
    sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1, 2
order by 1, 2
```

<PrintGroup>

**Exhibit 2.1 — Revenue by {inputs.grain}.** USD. The final period is partial.

<LineChart data={trend} x=period y=revenue yFmt=usdacck
  subtitle="Source: queries/metrics/average_order_value.sql · dbt metric revenue · excludes cancelled orders"
  chartAreaHeight=280/>

</PrintGroup>

<PrintGroup>

**Exhibit 2.2 — Revenue mix by region.** Percent of period total. Hues are pinned to the
entity, so removing a region from the filter never repaints the remaining series.

<AreaChart data={trend_mix} x=period y=revenue series=region type=stacked100
  subtitle="Source: queries/metrics/revenue.sql"
  chartAreaHeight=240
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a','Guest checkout':'#eda100'}}/>

</PrintGroup>

**Table 2.3 — Revenue by region and {inputs.grain}.** USD. The values behind Exhibit 2.2,
before the conversion to percent of period total.

<DataTable data={trend_mix} rows=12 search=true
  subtitle="Source: queries/metrics/revenue.sql">
  <Column id=period title="Period commencing" fmt=rptdate/>
  <Column id=region title="Region"/>
  <Column id=revenue title="Revenue" fmt=usdacc/>
</DataTable>

**Table 2.4 — Revenue by {inputs.grain}.** USD. Average order value is re-divided at the
display grain, never averaged.

<DataTable data={trend} totalRow=true
  subtitle="Source: queries/metrics/average_order_value.sql">
  <Column id=period title="Period commencing" fmt=rptdate/>
  <Column id=revenue title="Revenue" fmt=usdacc/>
  <Column id=order_count title="Orders" fmt=numacc/>
  <Column id=average_order_value title="Average order value" fmt=usdacc2
    totalAgg=weightedMean weightCol=order_count/>
</DataTable>

<PageBreak/>

## 3 · Composition and concentration

```sql weekly
-- daily rows are filtered to the selected range BEFORE the week roll-up, so a start
-- date falling mid-week never drags in revenue earned before the reporting period
select
    date_trunc('week', metric_time) as week,
    region,
    sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region != 'Guest checkout'
  and region in ${inputs.region.value}
group by 1, 2
order by 1, 2
```

```sql flow
select region as source, order_status as target, sum(revenue) as value
from ${metrics_revenue_by_dimensions}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1, 2
order by 3 desc
```

<PrintGroup>

**Exhibit 3.1 — Weekly revenue by region.** USD. Guest checkouts carry no region and are
excluded here. Weeks are built from daily rows already inside the selected period, so the
first and last weeks are partial rather than overstated.

<BarChart data={weekly} x=week y=revenue series=region type=stacked yFmt=usdacck
  subtitle="Source: queries/metrics/revenue.sql · rolled up to week grain"
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a'}}/>

</PrintGroup>

<PrintGroup>

**Exhibit 3.2 — Revenue by region and order state.** USD. Ribbon width is revenue.
Cancelled orders are excluded by the metric definition and therefore cannot appear here.

<SankeyDiagram data={flow} sourceCol=source targetCol=target valueCol=value
  valueFmt=usdacck linkColor=source nodeLabels=full chartAreaHeight=300
  subtitle="Source: queries/metrics/revenue_by_dimensions.sql"/>

</PrintGroup>

<Alert status=warning>

Revenue is reported **gross** and is not net of refunds. Refunded revenue shown above is
exposure carried in the headline figures, not a deduction already taken.

</Alert>

<PageBreak/>

## 4 · Detail

```sql detail
with cur as (
    select region, country_code,
           sum(revenue) as revenue,
           sum(order_count) as order_count
    from ${metrics_revenue_by_dimensions}
    where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
      and region in ${inputs.region.value}
    group by 1, 2
),
prev as (
    select region, country_code, sum(revenue) as revenue
    from ${metrics_revenue_by_dimensions}
    where metric_time
        between '${inputs.date_range.start}'::date
                - (('${inputs.date_range.end}'::date - '${inputs.date_range.start}'::date) + 1)::int
            and '${inputs.date_range.start}'::date - 1
      and region in ${inputs.region.value}
    group by 1, 2
)
select
    c.region,
    c.country_code,
    '/regions/' || c.region as region_url,
    c.revenue,
    c.order_count,
    c.revenue / nullif(c.order_count, 0) as average_order_value,
    c.revenue / nullif(sum(c.revenue) over (), 0) as revenue_share,
    -- materiality: movements on fewer than 10 orders are suppressed rather than
    -- reported as a percentage that a small base makes meaningless
    case when c.order_count >= 10
         then (c.revenue - p.revenue) / nullif(p.revenue, 0)
    end as revenue_variance
from cur c
left join prev p on p.region = c.region and p.country_code = c.country_code
order by c.revenue desc
```

**Table 4.1 — Revenue by region and country.** USD. Subtotal and total rows re-divide
average order value rather than averaging the rows above them. Movements on fewer than
10 orders are left blank (not meaningful).

<DataTable data={detail} link=region_url groupBy=region subtotals=true totalRow=true
  search=true rows=15 downloadable=true
  subtitle="Source: queries/metrics/revenue_by_dimensions.sql · click a row to drill into the region">
  <Column id=country_code title="Country"/>
  <Column id=revenue title="Revenue" fmt=usdacc contentType=bar/>
  <Column id=revenue_share title="Share" fmt=pctacc contentType=colorscale scaleColor=blue/>
  <Column id=order_count title="Orders" fmt=numacc/>
  <Column id=average_order_value title="Average order value" fmt=usdacc2
    totalAgg=weightedMean weightCol=order_count/>
  <Column id=revenue_variance title="vs prior period" fmt=pctacc contentType=delta/>
</DataTable>

<PageBreak/>

## 5 · Basis of preparation

Every figure in this report is produced by a metric defined **once**, in the dbt semantic
layer (`models/semantic/_metrics.yml`), and compiled one-to-one into a SQL file under
`queries/metrics/`. Report pages may filter, aggregate and format those metrics. They may
not restate a business rule.

1. **Scope.** Gross order revenue in USD. Cancelled orders are excluded by the metric
   filter (`order_status != 'cancelled'`), so no page can reinstate them. No other order
   or account exclusion is applied.
2. **Refunds.** Figures are *not* net of refunds. Refunded orders remain in revenue and are
   reported separately as exposure in section 3.
3. **Guest checkouts.** Orders with no customer record carry no region or country. They are
   bucketed as *Guest checkout* and are excluded from the EMEA share numerator while
   remaining in its denominator.
4. **Comparatives.** The prior period is the selected range shifted back by its own length,
   derived at query time and not stored.
5. **Cumulative measures.** Trailing-window metrics are compiled without dimension columns
   and cannot be sliced by the region filter.
6. **Materiality.** Country movements on fewer than 10 orders in the period are suppressed.
7. **Completeness.** The final period in every time series is partial. Data in this report
   ends <Value data={control} column=data_as_of fmt=rptdate/>.

### 5.1 Metric register

| Metric | Type | Rule | Compiled to |
|---|---|---|---|
| `revenue` | Simple | `sum(order_amount_usd)` where `order_status != 'cancelled'` | `queries/metrics/revenue.sql` |
| `order_count` | Simple | `count(order_id)` where `order_status != 'cancelled'` | `queries/metrics/order_count.sql` |
| `average_order_value` | Ratio | `sum(revenue) / sum(order_count)` — re-divided at every grain | `queries/metrics/average_order_value.sql` |
| `emea_revenue_share` | Ratio | revenue filtered to `region='EMEA'` ÷ revenue | `queries/metrics/emea_revenue_share.sql` |
| `revenue_growth_mom` | Derived | `offset_window: 1 month` → `lag()` at month grain | `queries/metrics/revenue_growth_mom.sql` |
| `revenue_trailing_28d` | Cumulative | 28-day window over the zero-filled daily series | `queries/metrics/revenue_trailing_28d.sql` |
| `revenue_mtd` | Cumulative | `grain_to_date: month` | `queries/metrics/revenue_mtd.sql` |
| `revenue_by_dimensions` | Artifact | `revenue` and `order_count` grouped by every declared dimension | `queries/metrics/revenue_by_dimensions.sql` |

Full definitions, including descriptions and caveats, are in the
[metric dictionary](/metrics).

### 5.2 Data lineage

    source systems (Shopify, demo POS)
      └─ dbt staging → intermediate → marts
           ├─ marts.fct_orders             one row per order
           ├─ marts.dim_customers          one row per customer
           └─ marts.metricflow_time_spine  daily calendar
      └─ models/semantic/_metrics.yml      THE DEFINITION
           └─ queries/metrics/*.sql        compiled, one file per metric
                └─ pages/reports/*.md      filter · aggregate · format only

Column-level lineage is held in the project knowledge graph — `graphify explain` resolves
any figure back to the source column that produced it.

### 5.3 Presentation standards

- **Figures** carry accounting formats registered once in
  `.evidence/customization/custom-formatting.json` (`usdacc`, `usdacc2`, `usdacck`,
  `numacc`, `pctacc`, `rptdate`), so adverse values render in parentheses everywhere and no
  page invents its own format string.
- **Colour** is drawn in fixed slot order from a palette validated against six mechanical
  checks on both the light and dark report surfaces. Status colours are reserved for
  variances and alerts and are never reused as a series colour.
- **Attribution** — every exhibit names the compiled query it reads from, so any figure can
  be traced to its definition without asking the author.
- **Print** — sections break onto their own pages, exhibits avoid splitting across a break,
  and the filter controls are hidden in print output.
