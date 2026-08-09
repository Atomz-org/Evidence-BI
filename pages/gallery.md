---
title: Dashboards, reports, apps, and everything in between
description: The layout system and component set of this stack, each shown working on real data.
full_width: true
---

Build polished analytical experiences for any use case. Every panel below is
live against `needful_things.orders` — 10,000 orders, 2019 to 2021 — and moves
when the filters do.

<Alert status="info">

A gallery, not a governed dashboard. These are ad-hoc aggregates, not metric
definitions — for those see the [Metric Dictionary](/metrics) and the
[Feature Tour](/showcase). This page exists to show what the *layout system* can
express.

</Alert>

```sql date_bounds
-- DateRange derives its bounds with min()/max() over a real date column, so it
-- needs a column rather than precomputed values. Two rows carry the same answer
-- as ten thousand and do not ship the table to the browser to get it.
select min(order_datetime) as order_date from needful_things.orders
union all
select max(order_datetime) from needful_things.orders
```

```sql category_options
select distinct category from needful_things.orders order by 1
```

## Filters

<Grid cols=3>

<DateRange
    name=range
    data={date_bounds}
    dates=order_date
    title="Period"
/>

<Dropdown name=category data={category_options} value=category title="Category">
    <DropdownOption valueLabel="All categories" value="%" />
</Dropdown>

<Dropdown name=grain title="Grain">
    <DropdownOption valueLabel="Monthly" value="month" />
    <DropdownOption valueLabel="Quarterly" value="quarter" />
</Dropdown>

</Grid>

Filters live in one row and apply top-down to everything beneath them — the rule
this project follows on every page, so a reader never has to work out which
control governs which chart.

```sql filtered
select
    date_trunc('${inputs.grain.value}', order_datetime) as period,
    category,
    channel_group,
    state,
    sum(sales)  as revenue,
    count(*)    as orders
from needful_things.orders
where order_datetime between '${inputs.range.start}' and '${inputs.range.end}'
  and category like '${inputs.category.value}'
group by 1, 2, 3, 4
```

```sql headline
select
    sum(revenue)                          as revenue,
    sum(orders)                           as orders,
    sum(revenue) / nullif(sum(orders), 0) as aov
from ${filtered}
```

```sql headline_trend
select period, sum(revenue) as revenue
from ${filtered}
group by 1 order by 1
```

<Grid cols=4>
    <BigValue data={headline} value=revenue fmt=usd0k title="Revenue in period" />
    <BigValue data={headline} value=orders fmt=num0 title="Orders in period" />
    <BigValue data={headline} value=aov fmt=usd2 title="Average order value" />
    <BigValue data={headline_trend} value=revenue sparkline=period fmt=usd0k title="Latest period" />
</Grid>

The fourth tile is the one carrying a reference. `sparkline` names a **date column
in the same dataset**, and BigValue reads that dataset's *last* row — so a tile
with a trend necessarily shows the latest period, not the total. Labelling it
"Revenue" would have quietly turned one month into three years.

---

## Visualizations

Publication-quality by default, because the theme decides the palette rather than
each chart. Eight categorical hues in a fixed, contrast-checked order — a ninth
is never invented.

```sql area_data
select period, category, sum(revenue) as revenue
from ${filtered}
group by 1, 2 order by 1
```

```sql channel_data
select channel_group, sum(revenue) as revenue
from ${filtered}
group by 1 order by 2 desc
```

<Grid cols=2>

<AreaChart
    data={area_data}
    x=period
    y=revenue
    series=category
    yFmt=usd0k
    title="Revenue by category"
/>

<BarChart
    data={channel_data}
    x=channel_group
    y=revenue
    yFmt=usd0k
    swapXY=true
    title="Revenue by channel group"
/>

</Grid>

<Details title="More marks — scatter and seasonality">

```sql scatter_data
select state, sum(revenue) as revenue, sum(orders) as orders
from ${filtered}
group by 1
```

```sql heat_data
select
    category,
    monthname(period) as month_name,
    sum(revenue)      as revenue
from ${filtered}
group by 1, 2
```

<Grid cols=2>
    <ScatterPlot data={scatter_data} x=orders y=revenue yFmt=usd0k title="Orders vs revenue, by state" />
    <Heatmap data={heat_data} x=month_name y=category value=revenue valueFmt=usd0k title="Seasonality by category" />
</Grid>

</Details>

---

## Data tables

Rich tables carry bars, subtotals and deltas, so a table is a chart when a chart
would be less precise.

```sql table_data
select
    category,
    channel_group,
    sum(revenue)                          as revenue,
    sum(orders)                           as orders,
    sum(revenue) / nullif(sum(orders), 0) as aov
from ${filtered}
group by 1, 2
order by 1, 3 desc
```

<DataTable data={table_data} groupBy=category subtotals=true totalRow=true rows=12 search=true>
    <Column id=channel_group title="Channel" />
    <Column id=revenue fmt=usd0k title="Revenue" contentType=bar />
    <Column id=orders fmt=num0 title="Orders" totalAgg=sum />
    <Column id=aov fmt=usd2 title="AOV" totalAgg=weightedMean weightCol=orders />
</DataTable>

Note the total row: `AOV` is a **weighted mean** over orders, not the mean of the
column. Averaging an average is the most common way a correct-looking table lies,
so the aggregation is declared rather than assumed.

### Sparklines inside a table

A sparkline column reads an *array* per row, so the series is aggregated into a
list in SQL rather than joined in at render time.

```sql spark_table
with monthly as (
    select
        category,
        date_trunc('month', order_datetime) as month,
        sum(sales)                          as revenue
    from needful_things.orders
    where order_datetime between '${inputs.range.start}' and '${inputs.range.end}'
      and category like '${inputs.category.value}'
    group by 1, 2
),
totals as (
    select
        category,
        sum(revenue)                                                   as revenue,
        array_agg({'month': month, 'revenue': revenue} order by month) as trend
    from monthly group by 1
),
change as (
    select
        category,
        sum(case when year(month) = 2021 then revenue end) as y2021,
        sum(case when year(month) = 2020 then revenue end) as y2020
    from monthly group by 1
)
select
    t.category,
    t.revenue,
    t.trend,
    (c.y2021 - c.y2020) / nullif(c.y2020, 0) as delta_pct
from totals t join change c on t.category = c.category
order by t.revenue desc
```

<DataTable data={spark_table} rows=6>
    <Column id=category title="Category" />
    <Column id=revenue fmt=usd0k title="Revenue" />
    <Column id=trend title="Monthly trend" contentType=sparkline sparkX=month sparkY=revenue />
    <Column id=delta_pct fmt=pct1 title="2021 vs 2020" contentType=delta />
</DataTable>

---

## Maps

```sql by_state
select state, sum(revenue) as revenue
from ${filtered}
group by 1
```

```sql top_states
select state, sum(revenue) as revenue
from ${filtered}
group by 1 order by 2 desc limit 10
```

<Grid cols=2>

<!--
  `abbreviations` is deliberately omitted rather than set to false. USMap computes
  its geojson key once at init (`nameProperty = abbreviations ? 'abbrev' : 'name'`)
  before the reactive toBoolean() coercion runs — so passing the string "false"
  from markdown is truthy, the map keys on 'abbrev', full state names match
  nothing, and it renders an empty outline with a populated legend. Leaving the
  prop off uses the real boolean default.
-->
<div id="state-map">
<USMap
    data={by_state}
    state=state
    value=revenue
    fmt=usd0k
    title="Revenue by state"
    legend=true
/>
</div>

<BarChart
    data={top_states}
    x=state
    y=revenue
    yFmt=usd0k
    swapXY=true
    title="Top 10 states"
/>

</Grid>

A choropleth flatters large areas — Montana looks important because it is big,
not because it sells. The ranked bars beside it are not decoration; they are the
reason the map is safe to show.

---

## Layouts

The layout system is a handful of components. Everything above is built from them.

<Tabs id="layouts">
<Tab label="Grid">

`<Grid cols=N>` lays children into N columns and wraps them on narrow screens.
Every two-panel row on this page is one.

```markdown
<Grid cols=3>
    <BigValue data={headline} value=revenue fmt=usd0k />
    <BigValue data={headline} value=orders  fmt=num0 />
    <BigValue data={headline} value=aov     fmt=usd2 />
</Grid>
```

<Grid cols=4>
    <BigValue data={headline} value=revenue fmt=usd0k title="Revenue" />
    <BigValue data={headline} value=orders fmt=num0 title="Orders" />
    <BigValue data={headline} value=aov fmt=usd2 title="AOV" />
    <BigValue data={headline_trend} value=revenue fmt=usd0k title="Latest period" />
</Grid>

</Tab>
<Tab label="Tabs">

Tabs hide detail without losing it — the second view is one click away rather
than a scroll, and it prints expanded, so a PDF loses nothing.

```markdown
<Tabs id="example">
    <Tab label="Chart"><LineChart data={x} .../></Tab>
    <Tab label="Table"><DataTable data={x}/></Tab>
</Tabs>
```

</Tab>
<Tab label="Accordion">

For a list of sections where a reader wants one at a time.

<Accordion>
    <AccordionItem title="What this page is filtered by">
        The period and category controls at the top. Every query below them reads
        <code>{'${filtered}'}</code>, so nothing can drift out of sync with the header.
    </AccordionItem>
    <AccordionItem title="What is excluded">
        Nothing. This gallery is deliberately unfiltered so the totals tie to the
        raw source; the governed pages state their exclusions in a subtitle.
    </AccordionItem>
</Accordion>

</Tab>
<Tab label="Details">

`<Details>` is the lightweight one — a single collapsible block, used above to
keep the secondary marks out of the way until they are wanted.

</Tab>
</Tabs>

---

## Custom components

When the built-ins run out, a component is a `.svelte` file in `components/` and
it is available on every page with no import.

This project ships one: **[noodle](/noodle)**, a drag-and-drop exploration
surface with a Show Me card, level-of-detail expressions and table calculations —
about 1,200 lines behind a single tag.

```markdown
<Noodle
    tables={['dbt_semantic.orders', 'dbt_semantic.customers']}
    initial={{ columns: ['ordered_date'], rows: ['order_amount_usd'] }}
/>
```

<Grid cols=2>
    <LinkButton url="/noodle">Open noodle</LinkButton>
    <LinkButton url="/noodle-cube">Open the governed version</LinkButton>
</Grid>

---

## Everything else, one line each

<Grid cols=2>

<div>

- **`<Value/>`** — a number inline in a sentence: revenue was <Value data={headline} column=revenue fmt=usd0k/> across <Value data={headline} column=orders fmt=num0/> orders.
- **`<Delta/>`** — a signed change with the right colour and arrow.
- **`<Alert/>`, `<Note/>`, `<Callout/>`** — the three weights of aside.
- **`<Modal/>`, `<HoverCard/>`** — detail on demand.

</div>

<div>

- **`<DownloadData/>`** — hands the reader the underlying rows.
- **`<LastRefreshed/>`** — when the data was built, not when the page loaded.
- **`<Sparkline/>`** — a trend small enough to sit in a sentence.
- **`<PageBreak/>`, `<PrintGroup/>`** — control what a PDF does.

</div>

</Grid>

<LastRefreshed prerendered=true/>
