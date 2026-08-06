-- saved_query: weekly_revenue_by_region — models/semantic/_metrics.yml
-- "Feeds the executive revenue dashboard." metrics: revenue, order_count,
-- average_order_value; group_by week x region; where region is not null
-- (guest checkouts excluded — they carry no region).
-- In production this same query is exported to bi_marts by dbt.
select
    date_trunc('week', ordered_date) as week,
    region,
    sum(order_amount_usd) as revenue,
    count(order_id) as order_count,
    sum(order_amount_usd) / nullif(count(order_id), 0) as average_order_value
from dbt_semantic.orders
where order_status != 'cancelled'
  and region != 'Guest checkout'
group by 1, 2
order by 1, 2
