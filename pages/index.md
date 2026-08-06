---
title: Revenue Overview
queries:
  - metrics/revenue.sql
  - metrics/average_order_value.sql
  - metrics/emea_revenue_share.sql
  - metrics/revenue_growth_mom.sql
  - metrics/revenue_trailing_28d.sql
  - metrics/revenue_mtd.sql
  - saved/weekly_revenue_by_region.sql
---

Gross order revenue in USD, **excluding cancelled orders** and internal test
accounts; not net of refunds. Every number on this page is a dbt semantic-layer
metric (`models/semantic/_metrics.yml`), compiled to `queries/metrics/`.

```sql date_bounds
select min(metric_time) as start_date, max(metric_time) as end_date
from ${metrics_revenue}
```

```sql region_list
select distinct region from ${metrics_revenue} order by region
```

<DateRange name=date_range data={date_bounds} dates=start_date defaultValue="All Time"/>
<Dropdown name=region data={region_list} value=region multiple=true selectAllByDefault=true title="Region"/>

```sql kpi
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
    (cur.order_count - prev.order_count) / nullif(prev.order_count, 0) as orders_growth
from cur, prev
```

```sql share
select sum(emea_revenue) / nullif(sum(revenue), 0) as emea_revenue_share
from ${metrics_emea_revenue_share}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
```

<Grid cols=4>
  <BigValue data={kpi} value=revenue title="Revenue" fmt=usd0k
    comparison=revenue_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=order_count title="Orders" fmt=num0
    comparison=orders_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=average_order_value title="Avg Order Value" fmt=usd2/>
  <BigValue data={share} value=emea_revenue_share title="EMEA Revenue Share" fmt=pct1
    description="Guest checkouts count in the denominator but not the numerator."/>
</Grid>

## Momentum

Cumulative metrics cover **all regions** — a trailing window can't be sliced by
filtering (see the metric definitions).

```sql trailing_28d
select metric_time, revenue_trailing_28d
from ${metrics_revenue_trailing_28d}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
order by metric_time desc
```

```sql mtd
select metric_time, revenue_mtd
from ${metrics_revenue_mtd}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
order by metric_time desc
```

```sql mom
select metric_time, revenue, revenue_growth_mom
from ${metrics_revenue_growth_mom}
order by metric_time desc
```

<Grid cols=2>
  <BigValue data={trailing_28d} value=revenue_trailing_28d title="Revenue, trailing 28 days"
    fmt=usd0k sparkline=metric_time sparklineType=area/>
  <BigValue data={mtd} value=revenue_mtd title="Revenue, month to date"
    fmt=usd0k sparkline=metric_time sparklineType=area/>
</Grid>

<DataTable data={mom} title="Month-over-month growth" subtitle="All regions, calendar months — the latest month is partial">
  <Column id=metric_time title="Month" fmt='mmm yyyy'/>
  <Column id=revenue title="Revenue" fmt=usd0/>
  <Column id=revenue_growth_mom title="MoM growth" fmt=pct1 contentType=delta/>
</DataTable>

## Trend

```sql revenue_trend
select metric_time, sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1
order by 1
```

<LineChart data={revenue_trend} x=metric_time y=revenue yFmt=usd0k
  title="Daily revenue" subtitle="Excludes cancelled orders; gap days shown as zero"
  chartAreaHeight=280/>

## Where it comes from

```sql weekly
select week, region, revenue
from ${saved_weekly_revenue_by_region}
where week between date_trunc('week', '${inputs.date_range.start}'::date) and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
order by week, region
```

```sql by_region
select
    region,
    '/regions/' || region as region_url,
    sum(revenue) as revenue,
    sum(order_count) as order_count,
    sum(revenue) / nullif(sum(order_count), 0) as average_order_value,
    sum(revenue) / nullif(sum(sum(revenue)) over (), 0) as revenue_share
from ${metrics_average_order_value}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1
order by revenue desc
```

<Grid cols=2>

<BarChart data={weekly} x=week y=revenue series=region type=stacked yFmt=usd0k
  title="Weekly revenue by region" subtitle="Guest checkouts carry no region and are excluded here"
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a'}}/>

<DataTable data={by_region} link=region_url title="By region" subtitle="Click a row to drill down" totalRow=true>
  <Column id=region title="Region"/>
  <Column id=revenue title="Revenue" fmt=usd0/>
  <Column id=order_count title="Orders" fmt=num0/>
  <Column id=average_order_value title="AOV" fmt=usd2 totalAgg=weightedMean weightCol=order_count/>
  <Column id=revenue_share title="Share" fmt=pct1/>
</DataTable>

</Grid>

<Details title="How these metrics are defined">

Definitions live in the dbt project (`models/semantic/_metrics.yml`) and are
compiled one-to-one into `queries/metrics/`. See the
[metric dictionary](/metrics) for every definition, or the
[dbt→Evidence contract](/metrics#governance) for how the compile works.

</Details>
