-- metric: average_order_value (ratio) — models/semantic/_metrics.yml
-- "Revenue divided by order count, both excluding cancelled orders."
-- Ratio rule: pages re-divide at their display grain —
-- sum(revenue) / sum(order_count) — NEVER avg(average_order_value).
-- Numerator and denominator columns are carried for exactly that purpose.
select
    ordered_date as metric_time,
    region,
    sum(order_amount_usd) as revenue,
    count(order_id) as order_count,
    sum(order_amount_usd) / nullif(count(order_id), 0) as average_order_value
from dbt_semantic.orders
where order_status != 'cancelled'
group by 1, 2
order by 1, 2
