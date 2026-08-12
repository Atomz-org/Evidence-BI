---
title: Feature Tour
description: Every capability of this Evidence + dbt semantic-layer stack, on real governed metrics.
queries:
  - metrics/revenue.sql
  - metrics/order_count.sql
  - metrics/average_order_value.sql
  - metrics/emea_revenue_share.sql
  - metrics/revenue_trailing_28d.sql
  - metrics/revenue_by_dimensions.sql
  - saved/weekly_revenue_by_region.sql
---

```sql tour_scope
select
    sum(revenue) as revenue,
    sum(order_count) as order_count,
    min(metric_time) as first_day,
    max(metric_time) as last_day
from ${metrics_average_order_value}
```

```sql tour_dims
-- 'Guest checkout' and 'guest' are synthetic buckets for orders with no customer
-- record, not a real region or country — they are left out of both counts.
select
    count(distinct region) filter (where region != 'Guest checkout') as regions,
    count(distinct country_code) filter (where country_code != 'guest') as countries,
    count(distinct order_status) as statuses
from ${metrics_revenue_by_dimensions}
```

This is a **tour, not a dashboard** — each chapter answers a real question *and*
names the capability it demonstrates. Nothing here is mock data: it runs on the
same dbt semantic-layer metrics as the [Revenue Overview](/), covering
<Value data={tour_scope} column=order_count fmt=num0/> orders worth
<Value data={tour_scope} column=revenue fmt=usd0k/> across
<Value data={tour_dims} column=countries fmt=num0/> countries and
<Value data={tour_dims} column=regions fmt=num0/> regions, from
<Value data={tour_scope} column=first_day fmt='mmm d, yyyy'/> to
<Value data={tour_scope} column=last_day fmt='mmm d, yyyy'/>. Guest checkouts have
no customer record, so the semantic layer buckets them as *Guest checkout* and
*guest* — synthetic values, excluded from both counts above.

**Chapter 1 is that paragraph.** Every figure in it is a `<Value/>` bound to a
query — prose that recomputes when the data does, so a deck never goes stale
between the build and the meeting. <LastRefreshed prefix="Sources built"/>

## 2 · One filter row drives every chart below

Four input types, one row, applied top-down. Nothing on this page is filtered
anywhere else.

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

<DateRange name=date_range data={date_bounds} dates=metric_time defaultValue="Last 30 Days"/>
<Dropdown name=region data={region_list} value=region multiple=true selectAllByDefault=true title="Region"/>
<ButtonGroup name=grain title="Grain">
  <ButtonGroupItem valueLabel="Day" value="day"/>
  <ButtonGroupItem valueLabel="Week" value="week" default/>
  <ButtonGroupItem valueLabel="Month" value="month"/>
</ButtonGroup>
<Slider name=target title="Daily revenue target" min=1000 max=10000 step=250 defaultValue=6000 fmt=usd0 showInput=true/>

## 3 · KPIs that carry their own comparison

A number with nothing to compare against is decoration. Three of these carry a
previous-period delta computed in SQL; the fourth carries its own trajectory.
The Revenue tile is a drill link whenever the region filter names exactly one
region — with several selected there is no single page to open, so the link goes
away rather than guessing.

The comparison window is the selected range shifted back by its own length, so
picking *All Time* deliberately blanks the deltas: there is no earlier period to
compare against, and an empty delta is the honest answer.

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
    (cur.order_count - prev.order_count) / nullif(prev.order_count, 0) as orders_growth,
    (cur.revenue / nullif(cur.order_count, 0) - prev.revenue / nullif(prev.order_count, 0))
        / nullif(prev.revenue / nullif(prev.order_count, 0), 0) as aov_growth
from cur, prev
```

```sql trailing_28d
select metric_time, revenue_trailing_28d
from ${metrics_revenue_trailing_28d}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
order by metric_time desc
```

<Grid cols=4>
  <BigValue data={kpi} value=revenue title="Revenue" fmt=usd0k
    comparison=revenue_growth comparisonFmt=pct1 comparisonTitle="vs prev period"
    link={Array.isArray(inputs.region.rawValues) && inputs.region.rawValues.length === 1 ? '/regions/' + inputs.region.rawValues[0].value : undefined}
    description="Links to the selected region's page only when one region is selected. That page carries its own date range and opens on its default — the range picked here is not passed through."/>
  <BigValue data={kpi} value=order_count title="Orders" fmt=num0
    comparison=orders_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=average_order_value title="Avg Order Value" fmt=usd2
    comparison=aov_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={trailing_28d} value=revenue_trailing_28d title="Revenue, trailing 28d"
    fmt=usd0k sparkline=metric_time sparklineType=area
    description="Cumulative metric — all regions, unaffected by the region filter."/>
</Grid>

## 4 · A trend that changes grain on click, and a target you can drag

The grain buttons rewrite `date_trunc()` in the query; the slider redraws the
reference line. Both are ordinary Evidence inputs — no callback code.

```sql trend
select
    date_trunc('${inputs.grain}', metric_time) as period,
    sum(revenue) as revenue,
    sum(order_count) as order_count
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

<Tabs>
<Tab label="Trend">

<LineChart data={trend} x=period y=revenue yFmt=usd0k
  title="Revenue by {inputs.grain}"
  subtitle="Excludes cancelled orders. Target line = daily target × days in the period (month ≈ 30). The final period is partial."
  chartAreaHeight=300>
  <ReferenceLine y={inputs.target * (inputs.grain === 'week' ? 7 : inputs.grain === 'month' ? 30 : 1)}
    label="Target" labelPosition=aboveStart color=positive/>
</LineChart>

</Tab>
<Tab label="Mix">

<AreaChart data={trend_mix} x=period y=revenue series=region type=stacked100
  title="Revenue mix by region" subtitle="Same query, share instead of level — one axis, never two"
  chartAreaHeight=300
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a','Guest checkout':'#eda100'}}/>

</Tab>
<Tab label="Data">

<DataTable data={trend} totalRow=true>
  <Column id=period title="Period" fmt='mmm d, yyyy'/>
  <Column id=revenue title="Revenue" fmt=usd0/>
  <Column id=order_count title="Orders" fmt=num0/>
</DataTable>

<DownloadData data={trend} text="Download this period series"/>

</Tab>
</Tabs>

The charts that carry a *Data* tab — this one and the distribution in chapter 6 —
put the table and its download one click away, and chapter 9 is the whole page as
a searchable, downloadable table. A number nobody can inspect is a number nobody
should act on.

## 5 · The same fact, read two ways

Left: composition over time. Right: the weekly pattern that a time series hides.
Hues are pinned to the entity, so filtering a region out never repaints the
survivors.

```sql weekly
select week, region, revenue
from ${saved_weekly_revenue_by_region}
where week between date_trunc('week', '${inputs.date_range.start}'::date) and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
order by week, region
```

```sql region_weekday
select
    region,
    strftime(metric_time, '%a') as weekday,
    date_part('dow', metric_time) as dow,
    sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1, 2, 3
order by 1, 3
```

<Grid cols=2>

<BarChart data={weekly} x=week y=revenue series=region type=stacked yFmt=usd0k
  title="Weekly revenue by region" subtitle="Guest checkouts carry no region — the saved query excludes the Guest checkout bucket"
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a'}}/>

<Heatmap data={region_weekday} x=weekday y=region value=revenue
  xSort=dow valueFmt=usd0k cellHeight=34
  title="Revenue by weekday" subtitle="Sequential ramp — one hue, magnitude only"/>

</Grid>

## 6 · What a normal day actually looks like

Totals hide shape. A distribution says whether a 6k day is routine or remarkable
— and the box plot says whether that answer depends on where you're standing.

```sql daily_totals
select metric_time, sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1
having sum(revenue) > 0
order by 1
```

```sql daily_spread
with d as (
    select region, metric_time, sum(revenue) as revenue
    from ${metrics_revenue}
    where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
      and region in ${inputs.region.value}
    group by 1, 2
)
select
    region,
    min(revenue) as low,
    quantile_cont(revenue, 0.25) as q1,
    median(revenue) as median_day,
    quantile_cont(revenue, 0.75) as q3,
    max(revenue) as high
from d
group by 1
order by median_day desc
```

<Tabs>
<Tab label="All days">

<Histogram data={daily_totals} x=revenue xFmt=usd0k
  title="Distribution of daily revenue" subtitle="Days with no orders excluded"
  chartAreaHeight=260/>

</Tab>
<Tab label="By region">

<BoxPlot data={daily_spread} name=region
  min=low intervalBottom=q1 midpoint=median_day intervalTop=q3 max=high
  yFmt=usd0k swapXY=true chartAreaHeight=260
  title="Daily revenue spread by region" subtitle="Whiskers are min/max, box is the interquartile range"/>

</Tab>
<Tab label="Data">

<DataTable data={daily_spread}>
  <Column id=region title="Region"/>
  <Column id=low title="Min day" fmt=usd0/>
  <Column id=q1 title="25th" fmt=usd0/>
  <Column id=median_day title="Median day" fmt=usd0/>
  <Column id=q3 title="75th" fmt=usd0/>
  <Column id=high title="Max day" fmt=usd0/>
</DataTable>

</Tab>
</Tabs>

## 7 · Where revenue comes from, and what state it lands in

The Sankey allocates revenue across two declared dimensions at once — region on
the left, order state on the right. Revenue here is gross and not net of refunds,
so each band is how much of a region's revenue landed in that state — a width,
not a lookup.

```sql flow
select
    region as source,
    order_status as target,
    sum(revenue) as value
from ${metrics_revenue_by_dimensions}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
group by 1, 2
order by 3 desc
```

```sql by_country
select
    country_code,
    region,
    sum(revenue) as revenue,
    sum(order_count) as order_count,
    sum(revenue) / nullif(sum(order_count), 0) as average_order_value
from ${metrics_revenue_by_dimensions}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region in ${inputs.region.value}
  and country_code != 'guest'
group by 1, 2
order by revenue desc
```

<SankeyDiagram data={flow} sourceCol=source targetCol=target valueCol=value
  valueFmt=usd0k linkColor=source nodeLabels=full chartAreaHeight=320
  title="Revenue by region and order state"
  subtitle="Cancelled orders never appear — the metric definition excludes them"/>

<BubbleChart data={by_country} x=order_count y=average_order_value size=revenue series=region
  xFmt=num0 yFmt=usd0 sizeFmt=usd0k chartAreaHeight=300
  xAxisTitle="Orders" yAxisTitle="Average order value"
  title="Country concentration" subtitle="Bubble area is revenue — volume and basket size are different problems. Guest checkouts have no country and are excluded."
  seriesColors={{'EMEA':'#2a78d6','AMER':'#eb6834','OTHER':'#1baf7a','Guest checkout':'#eda100'}}/>

## 8 · Cross-filter without writing SQL

Click any chip. The grid emits a `where` clause that the query below consumes
directly — this is the ad-hoc exploration that usually costs you a BI licence,
and it works on the governed metric, not a copy of it.

```sql cut_source
select region, country_code, order_status, order_shape, revenue
from ${metrics_revenue_by_dimensions}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
```

```sql cut_result
select
    order_status,
    sum(revenue) as revenue,
    sum(order_count) as order_count,
    sum(revenue) / nullif(sum(order_count), 0) as average_order_value
from ${metrics_revenue_by_dimensions}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and ${inputs.cut}
group by 1
order by revenue desc
```

```sql cut_total
select
    sum(revenue) as revenue,
    sum(order_count) as order_count
from ${metrics_revenue_by_dimensions}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and ${inputs.cut}
```

<DimensionGrid data={cut_source} metric="sum(revenue)" metricLabel="Revenue"
  name=cut fmt=usd0k limit=6
  title="Cut revenue by any dimension" subtitle="Selections combine with AND"/>

The current selection is worth <Value data={cut_total} column=revenue fmt=usd0k/>
across <Value data={cut_total} column=order_count fmt=num0/> orders.

<BarChart data={cut_result} x=order_status y=revenue yFmt=usd0k swapXY=true
  title="Selected revenue by order state" chartAreaHeight=200/>

## 9 · The table is the receipt

One table, eight features: grouping with subtotals, an in-cell delta, a
colour-scaled magnitude column, an in-cell bar, a sparkline built from an
aggregated array, a row link into the drill page, search, and a download.

```sql receipt
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
),
sparks as (
    select region, country_code,
           array_agg({'week': week, 'revenue': revenue} order by week) as trend
    from (
        select region, country_code,
               date_trunc('week', metric_time) as week,
               sum(revenue) as revenue
        from ${metrics_revenue_by_dimensions}
        where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
          and region in ${inputs.region.value}
        group by 1, 2, 3
    )
    group by 1, 2
)
select
    c.region,
    c.country_code,
    '/regions/' || c.region as region_url,
    c.revenue,
    c.order_count,
    c.revenue / nullif(c.order_count, 0) as average_order_value,
    (c.revenue - p.revenue) / nullif(p.revenue, 0) as revenue_growth,
    c.revenue / nullif(sum(c.revenue) over (), 0) as revenue_share,
    s.trend
from cur c
left join prev p on p.region = c.region and p.country_code = c.country_code
left join sparks s on s.region = c.region and s.country_code = c.country_code
order by c.revenue desc
```

<DataTable data={receipt} link=region_url search=true rows=12
  groupBy=region subtotals=true totalRow=true downloadable=true
  title="Revenue by region and country" subtitle="Click a row to drill into that region's page — it carries its own date range and opens on its default">
  <Column id=country_code title="Country"/>
  <Column id=revenue title="Revenue" fmt=usd0 contentType=bar/>
  <Column id=revenue_share title="Share" fmt=pct1 contentType=colorscale scaleColor=blue/>
  <Column id=order_count title="Orders" fmt=num0/>
  <Column id=average_order_value title="AOV" fmt=usd2 totalAgg=weightedMean weightCol=order_count/>
  <Column id=revenue_growth title="vs prev period" fmt=pct1 contentType=delta/>
  <Column id=trend title="Weekly" contentType=sparkline sparkX=week sparkY=revenue/>
</DataTable>

## 10 · Why you can trust the numbers

<Alert status=info>

Every figure on this page traces to a metric defined **once**, in dbt's semantic
layer. Pages filter, aggregate, and format. They never restate a business rule.

</Alert>

That is the whole difference between this and a folder of charts. When Finance
asks "does revenue include cancelled orders?", the answer is a file, not a
meeting.

<Accordion>
<AccordionItem title="The definition (dbt — models/semantic/_metrics.yml)">

````yaml
- name: revenue
  label: Revenue
  description: >
    Gross order revenue in USD, excluding cancelled orders and internal test
    accounts. NOT net of refunds — use net_revenue for that.
  type: simple
  type_params:
    measure:
      name: order_total
      fill_nulls_with: 0
      join_to_timespine: true
  filter: "{{ Dimension('order__order_status') }} != 'cancelled'"
````

</AccordionItem>
<AccordionItem title="The compiled query (queries/metrics/revenue.sql)">

One file per metric, same name, mechanically derived from the YAML above — the
`!= 'cancelled'` filter, the zero-fill, and the time spine all come from the
definition, not from a page.

````sql
with spine as (select date_day from dbt_semantic.time_spine),
dims  as (select distinct region from dbt_semantic.orders),
base  as (
    select ordered_date, region, sum(order_amount_usd) as revenue
    from dbt_semantic.orders
    where order_status != 'cancelled'
    group by 1, 2
)
select s.date_day as metric_time, d.region, coalesce(b.revenue, 0) as revenue
from spine s
cross join dims d
left join base b on b.ordered_date = s.date_day and b.region = d.region
````

</AccordionItem>
<AccordionItem title="The page (what you are reading)">

Pages consume the compiled query by id and may only filter, aggregate, and
format it:

````markdown
```sql revenue_by_period
select date_trunc('${inputs.grain}', metric_time) as period,
       sum(revenue) as revenue
from ${metrics_revenue}
where region in ${inputs.region.value}
group by 1 order by 1
```

<LineChart data={revenue_by_period} x=period y=revenue yFmt=usd0k/>
````

If a dashboard needs a number that has no metric, the fix is a dbt pull request
and a recompile — not ad-hoc SQL in a page. That review is the governance.

</AccordionItem>
<AccordionItem title="The palette (evidence.config.yaml)">

The eight categorical hues are not a taste decision. They pass six mechanical
checks — lightness band, chroma floor, colour-blind ΔE ≥ 8, normal-vision
ΔE ≥ 15, and contrast — on this project's real light **and** dark surfaces, with
the dark set re-stepped rather than flipped. Slot order is the safety mechanism,
so hues are assigned in fixed order and never cycled.

Try the theme switcher in the top bar: every chart above was validated on both
surfaces.

</AccordionItem>
</Accordion>

<Grid cols=3>
  <LinkButton url='/metrics'>Metric dictionary</LinkButton>
  <LinkButton url='/'>Revenue overview</LinkButton>
  <Modal title="What this stack replaces" buttonText="The pitch">

  **Looker** gives you a governed semantic layer and a licence per viewer.
  **Power BI** gives you fast authoring and a model that lives inside a `.pbix`
  nobody can diff. This gives you both halves as text: metrics in dbt YAML,
  dashboards in markdown, both in git, both reviewed as code, and a production
  build that **fails** when a query breaks — so a broken dashboard is caught in
  CI instead of in a board meeting.

  The trade you are making: no drag-and-drop authoring. Everything here is a
  file. That is the point.

  </Modal>
</Grid>
