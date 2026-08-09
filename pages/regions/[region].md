---
title: Region detail
queries:
  - metrics/revenue.sql
  - metrics/average_order_value.sql
---

# {params.region}

Revenue and order metrics for **{params.region}**, excluding cancelled orders.
[← Back to overview](/)

```sql date_bounds
-- Both ends in ONE column — DateRange runs min()/max() over the column named by
-- dates=, so min and max in separate columns leaves it a single value to work
-- from and every relative default anchors to the start of the data.
select min(metric_time) as metric_time from ${metrics_revenue}
union all
select max(metric_time) from ${metrics_revenue}
```

<DateRange name=date_range data={date_bounds} dates=metric_time defaultValue="Last 30 Days"/>

```sql kpi
with cur as (
    select sum(revenue) as revenue, sum(order_count) as order_count
    from ${metrics_average_order_value}
    where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
      and region = '${params.region}'
),
prev as (
    select sum(revenue) as revenue, sum(order_count) as order_count
    from ${metrics_average_order_value}
    where metric_time
        between '${inputs.date_range.start}'::date
                - (('${inputs.date_range.end}'::date - '${inputs.date_range.start}'::date) + 1)::int
            and '${inputs.date_range.start}'::date - 1
      and region = '${params.region}'
)
select
    cur.revenue,
    cur.order_count,
    cur.revenue / nullif(cur.order_count, 0) as average_order_value,
    (cur.revenue - prev.revenue) / nullif(prev.revenue, 0) as revenue_growth,
    (cur.order_count - prev.order_count) / nullif(prev.order_count, 0) as orders_growth
from cur, prev
```

<Grid cols=3>
  <BigValue data={kpi} value=revenue title="Revenue" fmt=usd0k
    comparison=revenue_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=order_count title="Orders" fmt=num0
    comparison=orders_growth comparisonFmt=pct1 comparisonTitle="vs prev period"/>
  <BigValue data={kpi} value=average_order_value title="Avg Order Value" fmt=usd2/>
</Grid>

```sql region_trend
select metric_time, sum(revenue) as revenue
from ${metrics_revenue}
where metric_time between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and region = '${params.region}'
group by 1
order by 1
```

<LineChart data={region_trend} x=metric_time y=revenue yFmt=usd0k
  title="Daily revenue — {params.region}" subtitle="Excludes cancelled orders; gap days shown as zero"
  chartAreaHeight=240/>

## Order log

Raw order records for audit — **all statuses**, including the cancelled orders
the metrics above exclude.

```sql order_log
select
    o.order_id,
    o.ordered_date,
    c.customer_email,
    o.order_status,
    o.line_item_count,
    o.order_amount_usd
from dbt_semantic.orders o
left join dbt_semantic.customers c using (customer_id)
where o.ordered_date between '${inputs.date_range.start}'::date and '${inputs.date_range.end}'::date
  and o.region = '${params.region}'
order by o.ordered_date desc
```

<DataTable data={order_log} search=true rows=15>
  <Column id=order_id title="Order"/>
  <Column id=ordered_date title="Date" fmt='mmm d'/>
  <Column id=customer_email title="Customer"/>
  <Column id=order_status title="Status"/>
  <Column id=line_item_count title="Lines" fmt=num0/>
  <Column id=order_amount_usd title="Amount" fmt=usd2/>
</DataTable>
