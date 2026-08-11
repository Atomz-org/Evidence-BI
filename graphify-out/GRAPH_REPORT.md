# Graph Report — Evidence BI

Generated from `graphify-out/graph.json` by `scripts/graphify-lineage.py`,
after lineage injection — so every figure below describes the graph as shipped.

## Summary
- 182 nodes · 321 edges · 10 communities
- 33 source files referenced
- Extraction: 320 EXTRACTED · 1 INFERRED
- Built from commit: `ec7e706cdcc05ad5420f7ef8c5a9773e4c47657e`

## Edges by relation
- `uses_column` — 85
- `contains` — 67
- `has_column` — 65
- `loads_query` — 28
- `references_query` — 25
- `derives_from` — 15
- `imports` — 15
- `references` — 12
- `derived_from` — 7
- `calls` — 1
- `writes` — 1

## God Nodes (most connected — the core abstractions)
1. `showcase.md` — 41 edges
2. `Revenue Overview` — 37 edges
3. `Metric Dictionary` — 33 edges
4. `revenue-performance.md` — 30 edges
5. `dependencies` — 16 edges
6. `average_order_value` — 15 edges
7. `Region Detail` — 14 edges
8. `revenue` — 13 edges
9. `marts.fct_orders` — 12 edges
10. `revenue_by_dimensions` — 11 edges

## Communities (10 total)

### Community 0 — "dependencies"
Nodes (31): @evidence-dev/bigquery, @evidence-dev/connector-gsheets, @evidence-dev/core-components, @evidence-dev/csv, @evidence-dev/databricks, @evidence-dev/duckdb, @evidence-dev/evidence, @evidence-dev/motherduck (+8 more)

### Community 3 — "scripts"
Nodes (20): axios, build, build:strict, dev, engines, jsonwebtoken, name, node (+12 more)

### Community 5 — "Evidence BI Skill"
Nodes (11): Component Cookbook, Design Principles, Evidence BI README, Evidence BI Skill, Evidence Configuration, dbt Semantic Integration, dbt Semantic Layer Contract, dbt Semantic Source (+2 more)

### Community 1 — "Enterprise reporting standard"
Nodes (10): Comparatives, Enterprise reporting standard, Evidence gotcha: fenced code blocks become queries, Materiality, Number conventions, Print and export, Report page skeleton, What a report carries that a dashboard doesn't (+2 more)

### Community 2 — "revenue-performance.md"
Nodes (10): 1 · Executive summary, 1.1 Period-on-period movement, 2 · Trend and mix, 3 · Composition and concentration, 4 · Detail, 5 · Basis of preparation, 5.1 Metric register, 5.2 Data lineage (+2 more)

### Community 7 — "showcase.md"
Nodes (10): 10 · Why you can trust the numbers, 2 · One filter row drives every chart below, 3 · KPIs that carry their own comparison, 4 · A trend that changes grain on click, and a target you can drag, 5 · The same fact, read two ways, 6 · What a normal day actually looks like, 7 · Where revenue comes from, and what state it lands in, 8 · Cross-filter without writing SQL (+2 more)

### Community 11 — "graphify-lineage.py"
Nodes (4): col_id(), file_node_id(), graphify-lineage.py, main()

### Community 9 — "Revenue Overview"
Nodes (3): Region Detail, Regions Index, Revenue Overview

### Community 12 — "sync-evidence-upstream.sh"
Nodes (2): sync-evidence-upstream.sh, sync-evidence-upstream.sh script

### Community 4 — "Metric Dictionary"
Nodes (1): Metric Dictionary

## Hyperedges (group relationships)
- **Design System Enforcement** — evidence_config, skill_design, skill_components, pages_index [EXTRACTED 0.90]
- **Design System Enforcement** — evidence_config, skill_design_principles, skill_components [EXTRACTED 1.00]

## Knowledge Gaps
- **68 node(s) with ≤1 connection:** `1.1 Period-on-period movement`, `10 · Why you can trust the numbers`, `2 · One filter row drives every chart below`, `2 · Trend and mix`, `3 · Composition and concentration` (+63 more)
- **80 node(s) outside every community** (80 of them injected lineage). Clustering runs during the `/graphify` rebuild, before lineage injection, so a column or query node minted here is only placed in a community once the next full rebuild sees it.
