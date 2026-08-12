---
title: Flint Charting
queries:
  - saved/weekly_revenue_by_region.sql
  - metrics/revenue_by_dimensions.sql
---

`<FlintChart>` describes a chart by what the data **means** — `Amount`, `Region`,
`Date` — and lets [Flint](https://github.com/microsoft/flint-chart) derive the
layout: axis steps, label rotation, legend placement, when a dense axis has to
wrap into facets, how much canvas the whole thing needs. Colour is **not** Flint's:
every chart below is re-inked from the validated palette in `evidence.config.yaml`
before it is drawn, so these charts and Evidence's own charts agree hue for hue.

Gross order revenue in USD, **excluding cancelled orders**; guest checkouts carry
no region and are excluded from the weekly series. This page is the working
reference for `.claude/skills/flint-chart` — every pattern here is meant to be
copied.

```sql region_list
select distinct region from ${saved_weekly_revenue_by_region} order by region
```

<Dropdown name=region data={region_list} value=region multiple=true selectAllByDefault=true title="Region"/>

```sql weekly
select week, region, revenue, order_count, average_order_value
from ${saved_weekly_revenue_by_region}
where region in ${inputs.region.value}
order by week, region
```

## Change over time

Two columns and a series. Flint reads `Date` on `week` and picks a time scale,
tick step and label format on its own; the only thing stated here is what the
columns mean.

<FlintChart
    data={weekly}
    chartType="Line Chart"
    x=week y=revenue series=region
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    fmt=usd0k
    title="Weekly revenue by region"
    subtitle="USD, excludes cancelled orders and guest checkouts"
    height=300
/>

## Magnitude comparison

Same data, same props, different `chartType`. The semantic types do not change
because the meaning of the columns did not change — which is the point of stating
them once.

```sql by_region
select region, sum(revenue) as revenue, sum(order_count) as order_count
from ${weekly}
group by region
order by revenue desc
```

<FlintChart
    data={by_region}
    chartType="Bar Chart"
    x=region y=revenue
    types={{ region: 'Region', revenue: 'Amount' }}
    fmt=usd0k
    title="Revenue by region"
    subtitle="Selected period, USD"
    height=260
/>

## Two dimensions and a measure

A `Heatmap` puts the measure on the colour channel, so the continuous ramp comes
from the project's sequential scale — one hue, reversed on the dark surface.

```sql status_shape
select order_status, order_shape, sum(revenue) as revenue
from ${metrics_revenue_by_dimensions}
group by 1, 2
order by 1, 2
```

<FlintChart
    data={status_shape}
    chartType="Heatmap"
    x=order_shape y=order_status
    encodings={{ color: 'revenue' }}
    types={{ order_shape: 'Category', order_status: 'Status', revenue: 'Amount' }}
    fmt=usd0k
    title="Revenue by order status and line shape"
    subtitle="USD, cancelled orders excluded upstream by the metric definition"
    height=240
/>

## Small multiples

`column=` hands the faceting decision to Flint: it wraps the panels into a grid,
sizes each one, keeps the y-axis title on the left column only and shares the
x-axis title across the bottom. Nothing here says how many panels there are.

<FlintChart
    data={weekly}
    chartType="Line Chart"
    x=week y=revenue series=region
    encodings={{ column: 'region' }}
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    fmt=usd0k
    title="Weekly revenue, one panel per region"
    subtitle="USD, shared y-scale across panels"
    height=260
    hasTable=true
/>

## The table is always reachable

Every chart above reads from one of these two result sets. A chart nobody can
check is a claim, not a number. The ⇪ in each chart's header is the other half
of that: the rows behind *that* chart, into a spreadsheet, without re-running
anything by hand.

<DataTable data={weekly} rows=12 search=true>
    <Column id=week fmt="mmm d, yyyy" title="Week"/>
    <Column id=region title="Region"/>
    <Column id=revenue fmt=usd0 title="Revenue"/>
    <Column id=order_count fmt=num0 title="Orders"/>
    <Column id=average_order_value fmt=usd0 title="AOV"/>
</DataTable>

## Checking your own chart

`showAudit=true` prints what the chart violates, under the chart, while you are
building it. The same rules run headless in `npm run dashboard:audit` — see
`.claude/skills/dashboard-loop`.

This one is deliberately wrong in three ways: no `fmt`, so the axis shows raw
floats; three series in light mode, which reaches the aqua slot that sits below
3:1 on white; and a `Date` on a bar chart's band axis, which has no tick
formatter and prints raw ISO timestamps. The first two the audit catches. The
third it cannot — format the date in SQL, or use a line chart.

<FlintChart
    data={weekly}
    chartType="Bar Chart"
    x=week y=revenue series=region
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    title="Deliberately unformatted, deliberately untitled series"
    height=240
    showAudit=true
/>
