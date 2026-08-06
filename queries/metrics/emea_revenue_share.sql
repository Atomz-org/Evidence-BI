-- metric: emea_revenue_share (ratio) — models/semantic/_metrics.yml
-- "Share of revenue from EMEA customers. Guest checkouts have no region and are
--  excluded from the numerator but included in the denominator."
-- Day grain, no dimensions (the region filter IS the definition).
-- Value is a fraction — Evidence pct formats own the x100.
select
    ordered_date as metric_time,
    sum(order_amount_usd) filter (where region = 'EMEA') as emea_revenue,
    sum(order_amount_usd) as revenue,
    sum(order_amount_usd) filter (where region = 'EMEA')
        / nullif(sum(order_amount_usd), 0) as emea_revenue_share
from dbt_semantic.orders
where order_status != 'cancelled'
group by 1
order by 1
