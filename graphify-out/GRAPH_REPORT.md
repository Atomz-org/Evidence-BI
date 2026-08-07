# Graph Report - Evidence  (2026-08-07)

## Corpus Check
- 32 files · ~16,770 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 196 nodes · 379 edges · 19 communities (8 shown, 11 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ec7e706c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dependencies
- Enterprise reporting standard
- revenue-performance.md
- scripts
- Metric Dictionary
- Evidence BI Skill
- customers.country_code
- showcase.md
- Revenue Overview
- graphify-lineage.py
- sync-evidence-upstream.sh
- customers.customer_email
- customers.customer_id
- customers.first_seen_at
- orders.customer_id
- orders.line_item_count
- orders.net_line_amount_usd
- orders.order_status
- orders.ordered_at

## God Nodes (most connected - your core abstractions)
1. `Revenue Overview` - 49 edges
2. `Metric Dictionary` - 44 edges
3. `orders.region` - 23 edges
4. `Region Detail` - 18 edges
5. `orders.order_amount_usd` - 15 edges
6. `orders.order_amount_usd` - 13 edges
7. `average_order_value.revenue` - 11 edges
8. `revenue.revenue` - 10 edges
9. `revenue_by_dimensions` - 10 edges
10. `Enterprise reporting standard` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.order_count`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Revenue Overview` --uses_column--> `weekly_revenue_by_region.week`  [EXTRACTED]
  pages/index.md → queries/saved/weekly_revenue_by_region.sql
- `Revenue Overview` --uses_column--> `revenue_mtd.metric_time`  [EXTRACTED]
  pages/index.md → queries/metrics/revenue_mtd.sql
- `Revenue Overview` --uses_column--> `revenue_mtd.revenue_mtd`  [EXTRACTED]
  pages/index.md → queries/metrics/revenue_mtd.sql
- `Revenue Overview` --uses_column--> `revenue_trailing_28d.metric_time`  [EXTRACTED]
  pages/index.md → queries/metrics/revenue_trailing_28d.sql

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Design System Enforcement** — evidence_config, skill_design, skill_components, pages_index [EXTRACTED 0.90]
- **Design System Enforcement** — evidence_config, skill_design_principles, skill_components [EXTRACTED 1.00]

## Communities (19 total, 11 thin omitted)

### Community 0 - "dependencies"
Cohesion: 0.06
Nodes (31): @evidence-dev/bigquery, @evidence-dev/connector-gsheets, @evidence-dev/core-components, @evidence-dev/csv, @evidence-dev/databricks, @evidence-dev/duckdb, @evidence-dev/evidence, @evidence-dev/motherduck (+23 more)

### Community 1 - "Enterprise reporting standard"
Cohesion: 0.20
Nodes (9): Comparatives, Enterprise reporting standard, Evidence gotcha: fenced code blocks become queries, Materiality, Number conventions, Print and export, Report page skeleton, What a report carries that a dashboard doesn't (+1 more)

### Community 2 - "revenue-performance.md"
Cohesion: 0.20
Nodes (9): 1.1 Period-on-period movement, 1 · Executive summary, 2 · Trend and mix, 3 · Composition and concentration, 4 · Detail, 5.1 Metric register, 5.2 Data lineage, 5.3 Presentation standards (+1 more)

### Community 3 - "scripts"
Cohesion: 0.10
Nodes (19): engines, node, npm, name, overrides, axios, jsonwebtoken, sqlite3 (+11 more)

### Community 4 - "Metric Dictionary"
Cohesion: 0.12
Nodes (30): order_count.metric_time, order_count.order_count, order_count.region, revenue_mtd.metric_time, revenue_mtd.revenue_mtd, time_spine.date_day, average_order_value.average_order_value, average_order_value.metric_time (+22 more)

### Community 5 - "Evidence BI Skill"
Cohesion: 0.22
Nodes (10): Evidence BI Skill, Evidence Configuration, Evidence BI README, sync-dbt.sh script, Component Cookbook, dbt Semantic Integration, dbt Semantic Layer Contract, Design Principles (+2 more)

### Community 7 - "showcase.md"
Cohesion: 0.09
Nodes (28): revenue_trailing_28d.metric_time, revenue_trailing_28d.revenue_trailing_28d, customers.country_code, customers.customer_email, customers.customer_id, customers.first_seen_at, customers.region, orders.line_item_count (+20 more)

### Community 9 - "Revenue Overview"
Cohesion: 0.13
Nodes (40): average_order_value.average_order_value, average_order_value.metric_time, average_order_value.order_count, average_order_value.region, average_order_value.revenue, emea_revenue_share.emea_revenue, emea_revenue_share.emea_revenue_share, emea_revenue_share.metric_time (+32 more)

## Knowledge Gaps
- **77 isolated node(s):** `name`, `version`, `build`, `build:strict`, `dev` (+72 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Revenue Overview` connect `Revenue Overview` to `Metric Dictionary`, `showcase.md`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `scripts`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `Metric Dictionary` connect `Metric Dictionary` to `Revenue Overview`, `showcase.md`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **What connects `name`, `version`, `build` to the rest of the system?**
  _77 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._
- **Should `scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Metric Dictionary` be split into smaller, more focused modules?**
  _Cohesion score 0.12413793103448276 - nodes in this community are weakly interconnected._