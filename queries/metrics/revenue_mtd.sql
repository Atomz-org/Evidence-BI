-- metric: revenue_mtd (cumulative, grain_to_date month) — models/semantic/_metrics.yml
-- "Revenue accumulated from the start of the calendar month."
-- Spine-filled daily series, running sum within each calendar month. No dimension
-- columns (cumulative — see revenue_trailing_28d.sql).
with daily as (
    select
        s.date_day as metric_time,
        coalesce(sum(o.order_amount_usd), 0) as revenue
    from dbt_semantic.time_spine s
    left join dbt_semantic.orders o
        on o.ordered_date = s.date_day
        and o.order_status != 'cancelled'
    group by 1
)
select
    metric_time,
    sum(revenue) over (
        partition by date_trunc('month', metric_time)
        order by metric_time
    ) as revenue_mtd
from daily
order by metric_time
