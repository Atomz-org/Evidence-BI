-- metrics: revenue, order_count — grouped by every categorical dimension declared
-- in models/semantic/_semantic_models.yml. This is a dimensional artifact of two
-- existing metrics, not a new metric: nothing here is defined that _metrics.yml
-- does not already define.
--
-- MetricFlow equivalent:
--   mf query --metrics revenue,order_count \
--            --group-by metric_time__day,customer__region,customer__country_code, \
--                       order__order_status,order__is_multi_line_order
--
-- Both metrics carry filter order_status != 'cancelled', so 'cancelled' never
-- appears in this artifact — that exclusion is the metric definition, not a page
-- choice. The `region` column is already denormalized on fct_orders (guest
-- checkouts bucketed there); country_code arrives through the customer foreign
-- entity, so guest checkouts land in 'guest'.
--
-- No join_to_timespine here: zero-filling a four-dimension cross product would be
-- ~98% empty rows. Every consumer of this file aggregates over time. For a
-- zero-filled daily series use revenue.sql / order_count.sql instead.
--
-- order_shape is order__is_multi_line_order relabelled for display — the YAML
-- expression is `case when line_item_count > 1 then true else false end`.
select
    o.ordered_date as metric_time,
    o.region,
    coalesce(c.country_code, 'guest') as country_code,
    o.order_status,
    case when o.line_item_count > 1 then 'Multi-line' else 'Single-line' end as order_shape,
    sum(o.order_amount_usd) as revenue,
    count(o.order_id) as order_count
from dbt_semantic.orders o
left join dbt_semantic.customers c using (customer_id)
where o.order_status != 'cancelled'
group by 1, 2, 3, 4, 5
order by 1, 2, 3, 4, 5
