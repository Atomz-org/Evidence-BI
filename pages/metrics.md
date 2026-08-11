---
title: Metric Dictionary
queries:
  - metrics/revenue.sql
  - metrics/order_count.sql
  - metrics/average_order_value.sql
  - metrics/emea_revenue_share.sql
  - metrics/revenue_growth_mom.sql
  - metrics/revenue_trailing_28d.sql
  - metrics/revenue_mtd.sql
---

Every metric in this project is defined **once**, in the dbt semantic layer
(`models/semantic/_metrics.yml`), and compiled one-to-one into
`queries/metrics/<metric_name>.sql`. Dashboards may filter, aggregate, and
format these — never redefine them. The values below are computed live from the
compiled queries over the full history, so this page doubles as a smoke test:
if a definition drifts, the number here drifts with it.

```sql totals
select
    (select sum(revenue) from ${metrics_revenue}) as revenue,
    (select sum(order_count) from ${metrics_order_count}) as order_count,
    (select sum(revenue) / nullif(sum(order_count), 0) from ${metrics_average_order_value}) as average_order_value,
    (select sum(emea_revenue) / nullif(sum(revenue), 0) from ${metrics_emea_revenue_share}) as emea_revenue_share,
    (select revenue_growth_mom from ${metrics_revenue_growth_mom} order by metric_time desc limit 1) as revenue_growth_mom,
    (select revenue_trailing_28d from ${metrics_revenue_trailing_28d} order by metric_time desc limit 1) as revenue_trailing_28d,
    (select revenue_mtd from ${metrics_revenue_mtd} order by metric_time desc limit 1) as revenue_mtd
```

## Simple

### Revenue `revenue`

> Gross order revenue in USD, excluding cancelled orders and internal test
> accounts. Verified against the NetSuite ledger for 2026-06 (0.02% variance).
> **Not net of refunds** — use `net_revenue` for that.

All time: <Value data={totals} column=revenue fmt=usd1k/> · measure
`order_total = sum(order_amount_usd)` · filter `order_status != 'cancelled'` ·
zero-filled onto the time spine · compiled: `queries/metrics/revenue.sql`

### Orders `order_count`

> Count of non-cancelled orders, excluding internal test accounts.

All time: <Value data={totals} column=order_count fmt=num0/> · measure
`order_count = count(order_id)` · compiled: `queries/metrics/order_count.sql`

## Ratio

### Average Order Value `average_order_value`

> Revenue divided by order count, both excluding cancelled orders.

All time: <Value data={totals} column=average_order_value fmt=usd2/> ·
**re-divide at the display grain** — `sum(revenue) / sum(order_count)`, never
`avg(average_order_value)` · compiled: `queries/metrics/average_order_value.sql`

### EMEA Revenue Share `emea_revenue_share`

> Share of revenue from EMEA customers. Guest checkouts have no region and are
> excluded from the numerator but included in the denominator.

All time: <Value data={totals} column=emea_revenue_share fmt=pct1/> ·
compiled: `queries/metrics/emea_revenue_share.sql`

## Derived

### Revenue Growth MoM `revenue_growth_mom`

> Month-over-month revenue growth, percent. Null for the first month in the
> series.

Latest month: <Value data={totals} column=revenue_growth_mom fmt=pct1/>
(partial month) · `offset_window: 1 month` → `lag()` at month grain · stored as
a fraction — display formatting owns the ×100 · compiled:
`queries/metrics/revenue_growth_mom.sql`

## Cumulative

Cumulative metrics are compiled without dimension columns — a trailing window
over an arbitrary dimension subset requires recomputation, not filtering.
Dashboards must not slice them by region.

### Revenue, Trailing 28 Days `revenue_trailing_28d`

> Rolling 28-day revenue. Requires the `metricflow_time_spine` model.

Today: <Value data={totals} column=revenue_trailing_28d fmt=usd1k/> ·
compiled: `queries/metrics/revenue_trailing_28d.sql`

### Revenue, Month to Date `revenue_mtd`

> Revenue accumulated from the start of the calendar month.

Today: <Value data={totals} column=revenue_mtd fmt=usd1k/> · compiled:
`queries/metrics/revenue_mtd.sql`

## Dimensional artifacts

Not every compiled file is a metric. `queries/metrics/revenue_by_dimensions.sql`
is the `revenue` and `order_count` metrics **grouped by every categorical
dimension declared** in `_semantic_models.yml` — region, country code, order
status, and multi-line flag — the equivalent of a single `mf query --group-by`.
It defines nothing new: both metrics carry the same
`order_status != 'cancelled'` filter, which is why cancelled orders never appear
in it.

It is deliberately **not** zero-filled onto the time spine — a four-dimension
cross product would be ~98% empty rows, and every consumer aggregates over time.
For a daily series with gaps as zeros, use `revenue.sql`. The
[Feature Tour](/showcase) is its main consumer.

## Governance

- **Change a metric in dbt, not here.** Edit `_metrics.yml` /
  `_semantic_models.yml`, rebuild, re-run `scripts/sync-dbt.sh`, recompile the
  affected `queries/metrics/*.sql`, and update this page. The diff is the
  metric review.
- **Cross-check a compile** against dbt:
  `dbt show --inline "select sum(order_amount_usd) from {{ ref('fct_orders') }} where order_status != 'cancelled'"`
  must equal the Revenue figure above.
- The full contract lives in
  `.claude/skills/evidence-bi/references/dbt-semantic-layer.md`.
