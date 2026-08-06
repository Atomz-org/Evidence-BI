# Graph Report - .  (2026-08-06)

## Corpus Check
- Corpus is ~8,613 words - fits in a single context window. You may not need a graph.

## Summary
- 140 nodes · 263 edges · 8 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Evidence Plugin Ecosystem
- Dashboard Pages & Metric Lineage
- Order Facts & Revenue Columns
- Package Manifest
- Time Spine & Cumulative Metrics
- BI Skill, Config & Sync Pipeline
- Customer Dimension Lineage

## God Nodes (most connected - your core abstractions)
1. `Revenue Overview` - 32 edges
2. `Metric Dictionary` - 29 edges
3. `orders.order_amount_usd` - 15 edges
4. `Region Detail` - 12 edges
5. `marts.fct_orders` - 12 edges
6. `scripts` - 8 edges
7. `orders.ordered_date` - 8 edges
8. `orders.region` - 8 edges
9. `time_spine.date_day` - 8 edges
10. `marts.dim_customers` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Revenue Overview` --uses_column--> `revenue_trailing_28d.revenue_trailing_28d`  [EXTRACTED]
  pages/index.md → queries/metrics/revenue_trailing_28d.sql
- `Revenue Overview` --uses_column--> `revenue_trailing_28d.metric_time`  [EXTRACTED]
  pages/index.md → queries/metrics/revenue_trailing_28d.sql
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.week`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.revenue`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.average_order_value`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Design System Enforcement** — evidence_config, skill_design, skill_components, pages_index [EXTRACTED 0.90]
- **Design System Enforcement** — evidence_config, skill_design_principles, skill_components [EXTRACTED 1.00]

## Communities (8 total, 0 thin omitted)

### Community 0 - "Evidence Plugin Ecosystem"
Cohesion: 0.06
Nodes (31): @evidence-dev/bigquery, @evidence-dev/connector-gsheets, @evidence-dev/core-components, @evidence-dev/csv, @evidence-dev/databricks, @evidence-dev/duckdb, @evidence-dev/evidence, @evidence-dev/motherduck (+23 more)

### Community 1 - "Dashboard Pages & Metric Lineage"
Cohesion: 0.22
Nodes (22): fct_orders.region, average_order_value.average_order_value, average_order_value.metric_time, average_order_value.order_count, average_order_value.region, average_order_value.revenue, emea_revenue_share.emea_revenue, emea_revenue_share.emea_revenue_share (+14 more)

### Community 2 - "Order Facts & Revenue Columns"
Cohesion: 0.13
Nodes (22): fct_orders.customer_id, fct_orders.line_item_count, fct_orders.net_line_amount_usd, fct_orders.order_amount_usd, fct_orders.order_id, fct_orders.order_status, fct_orders.ordered_at, fct_orders.ordered_date (+14 more)

### Community 3 - "Package Manifest"
Cohesion: 0.10
Nodes (19): engines, node, npm, name, overrides, axios, jsonwebtoken, sqlite3 (+11 more)

### Community 4 - "Time Spine & Cumulative Metrics"
Cohesion: 0.21
Nodes (10): metricflow_time_spine.date_day, order_count.metric_time, order_count.order_count, order_count.region, revenue_mtd.metric_time, revenue_mtd.revenue_mtd, revenue_trailing_28d.metric_time, revenue_trailing_28d.revenue_trailing_28d (+2 more)

### Community 5 - "BI Skill, Config & Sync Pipeline"
Cohesion: 0.20
Nodes (11): Evidence BI Skill, dbt Metrics Definition, Evidence Configuration, Evidence BI README, sync-dbt.sh script, Component Cookbook, dbt Semantic Integration, dbt Semantic Layer Contract (+3 more)

### Community 6 - "Customer Dimension Lineage"
Cohesion: 0.24
Nodes (11): dim_customers.country_code, dim_customers.customer_email, dim_customers.customer_id, dim_customers.first_seen_at, dim_customers.region, customers.country_code, customers.customer_email, customers.customer_id (+3 more)

## Knowledge Gaps
- **37 isolated node(s):** `name`, `version`, `build`, `build:strict`, `dev` (+32 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `marts.fct_orders` connect `Order Facts & Revenue Columns` to `Dashboard Pages & Metric Lineage`, `Time Spine & Cumulative Metrics`, `BI Skill, Config & Sync Pipeline`?**
  _High betweenness centrality (0.166) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Evidence Plugin Ecosystem` to `Package Manifest`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **Why does `marts.dim_customers` connect `Customer Dimension Lineage` to `BI Skill, Config & Sync Pipeline`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **What connects `name`, `version`, `build` to the rest of the system?**
  _37 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Evidence Plugin Ecosystem` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._
- **Should `Order Facts & Revenue Columns` be split into smaller, more focused modules?**
  _Cohesion score 0.13405797101449277 - nodes in this community are weakly interconnected._
- **Should `Package Manifest` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._