-- MetricFlow time spine (models/marts/metricflow_time_spine.sql), clipped to the
-- span of the order data. join_to_timespine / fill_nulls_with metrics and all
-- cumulative metrics build on this so gaps become zeros, not missing rows.
select date_day::date as date_day
from marts.metricflow_time_spine
where date_day::date between
    (select min(ordered_date) from marts.fct_orders)
    and (select max(ordered_date) from marts.fct_orders)
order by 1
