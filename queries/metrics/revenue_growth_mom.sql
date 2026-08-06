-- metric: revenue_growth_mom (derived) — models/semantic/_metrics.yml
-- "Month-over-month revenue growth, percent. Null for the first month in the series."
-- offset_window 1 month → lag() at month grain. The YAML expr multiplies by 100;
-- here the value stays a fraction so Evidence pct formats own the x100.
with monthly as (
    select
        date_trunc('month', ordered_date) as metric_time,
        sum(order_amount_usd) as revenue
    from dbt_semantic.orders
    where order_status != 'cancelled'
    group by 1
)
select
    metric_time,
    revenue,
    lag(revenue) over (order by metric_time) as revenue_prev_month,
    (revenue - lag(revenue) over (order by metric_time))
        / nullif(lag(revenue) over (order by metric_time), 0) as revenue_growth_mom
from monthly
order by metric_time
