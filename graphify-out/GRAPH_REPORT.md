# Graph Report - Evidence  (2026-08-07)

## Corpus Check
- 30 files · ~13,376 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 125 nodes · 168 edges · 22 communities (10 shown, 12 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1e930e28`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dependencies
- Revenue Overview
- average_order_value.average_order_value
- scripts
- Metric Dictionary
- Evidence BI Skill
- customers.country_code
- showcase.md
- orders.region
- Region Detail
- orders.order_amount_usd
- graphify-lineage.py
- sync-evidence-upstream.sh
- customers.customer_email
- customers.customer_id
- customers.first_seen_at
- customers.region
- orders.customer_id
- orders.line_item_count
- orders.net_line_amount_usd
- orders.order_status
- orders.ordered_at

## God Nodes (most connected - your core abstractions)
1. `Revenue Overview` - 25 edges
2. `Metric Dictionary` - 22 edges
3. `orders.order_amount_usd` - 13 edges
4. `Region Detail` - 10 edges
5. `scripts` - 8 edges
6. `Evidence BI Skill` - 6 edges
7. `orders.ordered_date` - 6 edges
8. `orders.region` - 6 edges
9. `time_spine.date_day` - 6 edges
10. `overrides` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.order_count`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.region`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.revenue`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Metric Dictionary` --uses_column--> `order_count.order_count`  [EXTRACTED]
  pages/metrics.md → queries/metrics/order_count.sql
- `Metric Dictionary` --uses_column--> `order_count.region`  [EXTRACTED]
  pages/metrics.md → queries/metrics/order_count.sql

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Design System Enforcement** — evidence_config, skill_design, skill_components, pages_index [EXTRACTED 0.90]
- **Design System Enforcement** — evidence_config, skill_design_principles, skill_components [EXTRACTED 1.00]

## Communities (22 total, 12 thin omitted)

### Community 0 - "dependencies"
Cohesion: 0.06
Nodes (31): @evidence-dev/bigquery, @evidence-dev/connector-gsheets, @evidence-dev/core-components, @evidence-dev/csv, @evidence-dev/databricks, @evidence-dev/duckdb, @evidence-dev/evidence, @evidence-dev/motherduck (+23 more)

### Community 1 - "Revenue Overview"
Cohesion: 0.48
Nodes (7): average_order_value.metric_time, emea_revenue_share.metric_time, revenue_growth_mom.metric_time, revenue_growth_mom.revenue_growth_mom, weekly_revenue_by_region.week, orders.ordered_date, Revenue Overview

### Community 2 - "average_order_value.average_order_value"
Cohesion: 0.33
Nodes (6): average_order_value.average_order_value, average_order_value.order_count, order_count.order_count, weekly_revenue_by_region.average_order_value, weekly_revenue_by_region.order_count, orders.order_id

### Community 3 - "scripts"
Cohesion: 0.10
Nodes (19): engines, node, npm, name, overrides, axios, jsonwebtoken, sqlite3 (+11 more)

### Community 4 - "Metric Dictionary"
Cohesion: 0.43
Nodes (8): order_count.metric_time, revenue.metric_time, revenue_mtd.metric_time, revenue_mtd.revenue_mtd, revenue_trailing_28d.metric_time, revenue_trailing_28d.revenue_trailing_28d, time_spine.date_day, Metric Dictionary

### Community 5 - "Evidence BI Skill"
Cohesion: 0.22
Nodes (10): Evidence BI Skill, Evidence Configuration, Evidence BI README, sync-dbt.sh script, Component Cookbook, dbt Semantic Integration, dbt Semantic Layer Contract, Design Principles (+2 more)

### Community 7 - "showcase.md"
Cohesion: 0.20
Nodes (9): 10 · Why you can trust the numbers, 2 · One filter row drives every chart below, 3 · KPIs that carry their own comparison, 4 · A trend that changes grain on click, and a target you can drag, 5 · The same fact, read two ways, 6 · What a normal day actually looks like, 7 · Where revenue comes from, and what state it lands in, 8 · Cross-filter without writing SQL (+1 more)

### Community 8 - "orders.region"
Cohesion: 0.33
Nodes (6): average_order_value.region, emea_revenue_share.emea_revenue, emea_revenue_share.emea_revenue_share, order_count.region, weekly_revenue_by_region.region, orders.region

### Community 9 - "Region Detail"
Cohesion: 0.40
Nodes (5): average_order_value.revenue, revenue.region, revenue.revenue, Regions Index, Region Detail

### Community 10 - "orders.order_amount_usd"
Cohesion: 0.40
Nodes (5): emea_revenue_share.revenue, revenue_growth_mom.revenue, revenue_growth_mom.revenue_prev_month, weekly_revenue_by_region.revenue, orders.order_amount_usd

## Knowledge Gaps
- **56 isolated node(s):** `name`, `version`, `build`, `build:strict`, `dev` (+51 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `scripts`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `Revenue Overview` connect `Revenue Overview` to `average_order_value.average_order_value`, `Metric Dictionary`, `orders.region`, `Region Detail`, `orders.order_amount_usd`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **What connects `name`, `version`, `build` to the rest of the system?**
  _56 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._
- **Should `scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._