-- metric: revenue_trailing_28d (cumulative, window 28 days) — models/semantic/_metrics.yml
-- "Rolling 28-day revenue. Requires the metricflow_time_spine model."
-- Built on the spine-filled daily series: a window over gapped data is silently
-- wrong. No dimension columns — cumulative metrics cannot be sliced by filtering
-- (pages say "all regions" in the subtitle).
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
        order by metric_time
        rows between 27 preceding and current row
    ) as revenue_trailing_28d
from daily
order by metric_time
