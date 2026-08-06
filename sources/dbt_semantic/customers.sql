-- Semantic model: customers (models/semantic/_semantic_models.yml). One row per
-- customer, current state.
select
    customer_id,
    customer_email,
    country_code,
    region,
    first_seen_at
from marts.dim_customers
