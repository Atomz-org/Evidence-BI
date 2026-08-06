-- metric: order_count (simple) — models/semantic/_metrics.yml
-- "Count of non-cancelled orders, excluding internal test accounts."
-- measure order_count = count(order_id); filter order_status != 'cancelled'.
with spine as (
    select date_day from dbt_semantic.time_spine
),
dims as (
    select distinct region from dbt_semantic.orders
),
base as (
    select ordered_date, region, count(order_id) as order_count
    from dbt_semantic.orders
    where order_status != 'cancelled'
    group by 1, 2
)
select
    s.date_day as metric_time,
    d.region,
    coalesce(b.order_count, 0) as order_count
from spine s
cross join dims d
left join base b
    on b.ordered_date = s.date_day
    and b.region = d.region
order by 1, 2
