-- Semantic model: orders (models/semantic/_semantic_models.yml). One row per order.
-- Region arrives via the customer entity join, already denormalized on fct_orders.
-- Guest checkouts (no customer record) get an explicit bucket here so every page
-- groups them identically.
select
    order_id,
    customer_id,
    coalesce(region, 'Guest checkout') as region,
    order_status,
    line_item_count,
    order_amount_usd,
    net_line_amount_usd,
    ordered_at,
    ordered_date
from marts.fct_orders
