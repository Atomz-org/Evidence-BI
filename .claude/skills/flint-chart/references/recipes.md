# Recipes — working `<FlintChart>` blocks

Every block here runs against this project's real metrics. The live versions are
on [`pages/flint.md`](../../../../pages/flint.md).

The shape is always the same: a query block that reaches a metric, then a chart
that states what the columns mean.

## Trend, one line per category

```svelte
```sql weekly
select week, region, revenue
from ${saved_weekly_revenue_by_region}
where region in ${inputs.region.value}
order by week, region
```

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
```

## Magnitude across categories

`Bar Chart` with no `series` — one measure, one bar per category. Sort in SQL;
Flint respects the row order for nominal categories.

```svelte
```sql by_region
select region, sum(revenue) as revenue
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
```

## Two categories side by side

`Grouped Bar Chart` and the `group` channel. Putting the second category on
`series` instead would stack it.

```svelte
<FlintChart
    data={status_by_region}
    chartType="Grouped Bar Chart"
    x=region y=revenue
    encodings={{ group: 'order_status' }}
    types={{ region: 'Region', order_status: 'Status', revenue: 'Amount' }}
    fmt=usd0k
    title="Revenue by region and order status"
    subtitle="USD, cancelled excluded upstream by the metric definition"
/>
```

## Two dimensions, measure on colour

The continuous ramp comes from the project's sequential scale — one hue, reversed
on the dark surface.

```svelte
<FlintChart
    data={status_shape}
    chartType="Heatmap"
    x=order_shape y=order_status
    encodings={{ color: 'revenue' }}
    types={{ order_shape: 'Category', order_status: 'Status', revenue: 'Amount' }}
    fmt=usd0k
    title="Revenue by order status and line shape"
    height=240
/>
```

## Small multiples

Hand Flint the faceting field and it decides the grid, the wrap, and which panels
keep their axis titles. This is the right move above four series.

```svelte
<FlintChart
    data={weekly}
    chartType="Line Chart"
    x=week y=revenue series=region
    encodings={{ column: 'region' }}
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    fmt=usd0k
    title="Weekly revenue, one panel per region"
    subtitle="USD, shared y-scale across panels"
    hasTable=true
/>
```

## Composition over time

```svelte
<FlintChart
    data={weekly}
    chartType="Area Chart"
    x=week y=revenue series=region
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    properties={{ stackMode: 'normalize' }}
    fmt=pct1
    title="Share of revenue by region"
    subtitle="Stacked to 100%, weekly"
/>
```

Note `fmt=pct1` follows `stackMode: 'normalize'` — the axis now carries shares,
not dollars, and the format has to say so.

## Actual against target

`Bullet Chart` and the `goal` channel. Prefer this over a gauge: it fits in a row,
prints, and shows several measures against their targets at once.

```svelte
<FlintChart
    data={targets}
    chartType="Bullet Chart"
    y=metric x=actual
    encodings={{ goal: 'target' }}
    types={{ metric: 'Name', actual: 'Amount', target: 'Amount' }}
    fmt=usd0k
    title="Performance against plan"
    subtitle="Current quarter, USD"
    height=200
/>
```

## Distribution per category

```svelte
<FlintChart
    data={order_values}
    chartType="Boxplot"
    x=region y=order_amount_usd
    types={{ region: 'Region', order_amount_usd: 'Amount' }}
    properties={{ showOutliers: true }}
    fmt=usd0
    title="Order value distribution by region"
    subtitle="USD per order, cancelled excluded"
/>
```

## How a total was reached

```svelte
<FlintChart
    data={bridge}
    chartType="Waterfall Chart"
    x=step y=delta
    types={{ step: 'Category', delta: 'Profit' }}
    fmt=usd0k
    title="Revenue bridge, prior period to current"
    subtitle="USD, contributions by driver"
/>
```

`delta` is typed `Profit` rather than `Amount` because the steps can be negative
and `Profit` is the signed money type.

## Debugging a chart while you build it

`showAudit=true` prints the rule violations under the chart. Take it off before
committing — `npm run dashboard:audit` covers the page headlessly.

```svelte
<FlintChart
    data={weekly}
    chartType="Bar Chart"
    x=week y=revenue series=region
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    title="What is wrong with this chart"
    showAudit=true
/>
```

## Anti-patterns

```svelte
<!-- No types. Flint sniffs, and every scale decision becomes a guess. -->
<FlintChart data={weekly} chartType="Line Chart" x=week y=revenue />

<!-- A colour. The palette is validated and comes from evidence.config.yaml. -->
<FlintChart ... properties={{ color: '#ff0088' }} />

<!-- A Flint theme preset. Silently ignored by the ECharts backend. -->
<FlintChart ... theme="economist" />

<!-- Nine series against an eight-slot palette. Fold or facet. -->
<FlintChart data={by_country} chartType="Line Chart" x=week y=revenue series=country_code />

<!-- Two measures of different scale on one plot. Two charts, or index to 100. -->
<FlintChart ... y=revenue encodings={{ y2: 'order_count' }} />

<!-- Aggregating in the chart. Flint accepts this — but this project does not:
     every number traces to a metric, and an aggregate hidden in a prop is
     invisible to the semantic layer, to the audit, and to the next reader. -->
<FlintChart ... encodings={{ y: { field: 'revenue', aggregate: 'sum' } }} />
```

That last one is the only anti-pattern here that Flint itself would allow.
`ChartEncoding` really does support `aggregate: 'sum' | 'count' | 'average' |
'mean'`; the rule against it is this project's, not the library's. Aggregate in
the query block, where the grain is visible and `${metrics_…}` says where the
number came from.
