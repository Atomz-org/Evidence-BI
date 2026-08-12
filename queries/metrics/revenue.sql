-- metric: revenue (simple) — models/semantic/_metrics.yml
-- "Gross order revenue in USD, excluding cancelled orders.
--  NOT net of refunds — use net_revenue for that."
-- measure order_total = sum(order_amount_usd); filter order_status != 'cancelled';
-- fill_nulls_with 0 + join_to_timespine, applied per (day, region) as MetricFlow
-- does when a categorical dimension is in the group-by.
with spine as (
    select date_day from dbt_semantic.time_spine
),
dims as (
    select distinct region from dbt_semantic.orders
),
base as (
    select ordered_date, region, sum(order_amount_usd) as revenue
    from dbt_semantic.orders
    where order_status != 'cancelled'
    group by 1, 2
)
select
    s.date_day as metric_time,
    d.region,
    coalesce(b.revenue, 0) as revenue
from spine s
cross join dims d
left join base b
    on b.ordered_date = s.date_day
    and b.region = d.region
order by 1, 2
