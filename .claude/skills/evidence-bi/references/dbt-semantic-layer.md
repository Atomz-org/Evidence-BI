# dbt semantic layer → Evidence: the integration contract

dbt (MetricFlow) owns metric *definitions*; Evidence owns *presentation*. On dbt
Core the hosted Semantic Layer API is unavailable (dbt Cloud only), so this
project compiles the YAML into Evidence's query layer mechanically. The result:
one definition, versioned in dbt, rendered in Evidence — no filter drift between
BI and warehouse.

## The pipeline

```
dbt project:  models/semantic/_semantic_models.yml   (entities, dimensions, measures)
              models/semantic/_metrics.yml           (metrics, saved queries)
                        │  dbt build  →  marts in dev.duckdb
                        ▼
Evidence:     scripts/sync-dbt.sh                    (copies dev.duckdb into sources/dbt_semantic/)
              sources/dbt_semantic/*.sql             (extract marts: orders, customers, time_spine)
              queries/metrics/<metric_name>.sql      (one file per dbt metric — compiled by hand/agent)
              queries/saved/<saved_query>.sql        (one file per dbt saved_query)
              pages/*.md                             (filter + aggregate + render ONLY)
```

Current binding: `DBT_PROJECT_DIR` defaults to
`code-skills/skill-packs/dbt-skills/use-cases/example-order-revenue-mart/dbt_project`
(override in `scripts/sync-dbt.sh` or via env var to point at another dbt repo).

## Naming contract

| dbt object | Evidence file | Query id in pages |
|---|---|---|
| metric `revenue` | `queries/metrics/revenue.sql` | `${metrics_revenue}` |
| metric `revenue_trailing_28d` | `queries/metrics/revenue_trailing_28d.sql` | `${metrics_revenue_trailing_28d}` |
| saved query `weekly_revenue_by_region` | `queries/saved/weekly_revenue_by_region.sql` | `${saved_weekly_revenue_by_region}` |
| semantic model `orders` | source extract `dbt_semantic.orders` | `dbt_semantic.orders` |

Conventions inside every metric file:

- Time column is always **`metric_time`** (MetricFlow's name), day grain unless
  the metric dictates otherwise (monthly for MoM-offset metrics).
- The value column is named **exactly after the metric**.
- Dimension columns (from the semantic model's entities/dimensions) may be
  included so pages can slice — e.g. `region` on day-grain simple metrics.
- The file header comment cites the YAML source and restates its `description`.

## Compilation rules by metric type

### simple

`measure` → aggregation from `_semantic_models.yml`; `filter:` → `WHERE`;
`fill_nulls_with: 0` + `join_to_timespine: true` → LEFT JOIN from the time spine.

```sql
-- metric: revenue (simple). filter: order_status != 'cancelled';
-- measure order_total = sum(order_amount_usd); fill_nulls_with 0 + timespine
select s.date_day::date as metric_time,
       coalesce(sum(o.order_amount_usd), 0) as revenue
from dbt_semantic.time_spine s
left join dbt_semantic.orders o
  on o.ordered_date = s.date_day::date and o.order_status != 'cancelled'
where s.date_day::date between (select min(ordered_date) from dbt_semantic.orders)
                           and (select max(ordered_date) from dbt_semantic.orders)
group by 1
```

(When the metric keeps dimensions for slicing, skip the spine fill and document
that pages must handle gaps — you cannot fill per-dimension without a cross join.)

### ratio

Compile numerator and denominator (with their own filters), join on
`metric_time` (+ shared dimensions), divide **as a fraction** (Evidence `pct`
formats multiply by 100). Never average a pre-computed ratio over rows — always
re-divide at the display grain (sum numerator / sum denominator).

### derived

Compile each input metric, apply the `expr`. `offset_window: 1 month` →
aggregate to month grain and `lag(value) over (order by month)`. If the YAML
expr multiplies by 100, keep the Evidence column a fraction and note the
divergence in the header comment — display formatting owns the ×100.

### cumulative

Always build on the spine-filled daily series (window functions over gapped
data are silently wrong):

- `window: 28 days` → `sum(x) over (order by metric_time rows between 27 preceding and current row)`
- `grain_to_date: month` → `sum(x) over (partition by date_trunc('month', metric_time) order by metric_time)`

Cumulative metrics are compiled **without** dimension columns — a trailing
window over an arbitrary dimension subset requires recomputation, not
filtering. Pages must not slice them by dimension; say "all regions" in the
chart subtitle.

### saved_queries

Compile `query_params` literally: `metrics:` → join the compiled metrics,
`group_by` TimeDimension grain → `date_trunc`, `where:` → WHERE. These feed
the flagship dashboards, same as their exports feed `bi_marts`.

## Governance rules

1. **Page SQL never restates business logic.** Status exclusions, test-account
   filters, fill semantics live in dbt YAML → compiled metric files. Pages only
   filter by dimensions/dates, aggregate to display grain, and format. If a page
   needs logic that doesn't exist, the fix is a dbt metric PR, then a recompile.
2. **Recompile on YAML change.** When `_metrics.yml` / `_semantic_models.yml`
   change, regenerate the affected `queries/metrics/*.sql` and update
   `pages/metrics.md` (the dictionary). Diff review = metric review.
3. **The dictionary page (`pages/metrics.md`) is generated from the YAML
   descriptions** — labels, types, definitions, caveats. It is the analog of
   Looker's field picker docs; keep it current or the semantic layer is folklore.
4. **Verify a compile** by cross-checking one aggregate against dbt:
   `dbt show --inline "select sum(order_amount_usd) from {{ ref('fct_orders') }} where order_status != 'cancelled'"`
   must equal `select sum(revenue) from ${metrics_revenue}`.
5. Guest checkouts (NULL region) display as `'Guest checkout'` via
   `coalesce` **in the metric file**, not per-page — so every page buckets them
   identically. Ratio metrics that exclude guests from a numerator (e.g.
   `emea_revenue_share`) inherit that from the YAML filter, never from a page.

## Column lineage in the knowledge graph

`graphify-out/graph.json` carries the full lineage this file describes, machine-
queryable: `loads_query` (frontmatter), `references_query` (`${}` chains),
`reads_table`, `derived_from` (through to the dbt marts), and per-column
`has_column` / `derives_from` / `uses_column` edges whose `context` holds the
defining SQL expression. Before reading files to answer "how is metric X
computed" or "what breaks if column Y changes", query the graph — it is faster
and already resolves CTEs:

```bash
graphify explain "revenue_trailing_28d.revenue_trailing_28d"
graphify query "what depends on orders.order_amount_usd?"
```

The AST pass cannot see Evidence frontmatter, so `scripts/graphify-lineage.py`
(sqlglot-based, deterministic) supplies the lineage. Every record it writes is
stamped `_origin: "lineage"`, and each run **drops the previous generation of
those records before re-deriving them** from the files as they stand now. So
re-running it converges: a renamed or deleted column leaves no stale edge, an
edited SQL expression gets a fresh `context`, and running it three times in a
row produces byte-identical `graph.json`, `GRAPH_REPORT.md` and `graph.html`.
Records from graphify's own passes (`_origin: "ast"` / `"semantic"`) are never
touched.

One thing it still cannot do is invent a node for a page graphify has not seen:
a page with no node in the graph is skipped, because there is nothing to hang
its lineage off. So after adding a page, run the full sequence:

```bash
rm -rf graphify-out/     # 1. discard the old graph entirely
/graphify                # 2. full rebuild — this is what creates the page nodes
$(cat graphify-out/.graphify_python) scripts/graphify-lineage.py   # 3. inject lineage
```

Step 3 alone is enough after editing a query's columns or a page's SQL. It is
also the step that rewrites `GRAPH_REPORT.md` and the embedded data in
`graph.html`: graphify writes both during clustering, which is necessarily
before injection, so left alone they would describe a graph that no longer
exists. Clustering itself only runs in step 2 — nodes minted in step 3 sit
outside every community until the next full rebuild, and the report says so
rather than quietly dropping them from its totals.

## Alternative integration modes (when not on DuckDB)

- **Warehouse exports** (BigQuery/Snowflake): dbt `saved_queries` exports land
  tables in `bi_marts`; point an Evidence source of the matching adapter at that
  schema and keep `queries/` identical. This is the production topology — the
  YAML in this repo already exports `weekly_revenue_by_region`.
- **MetricFlow CLI spot-checks**: `mf query --metrics revenue --group-by
  metric_time__week` validates a compiled file against MetricFlow's own SQL.
- **dbt Cloud Semantic Layer API**: if the project moves to dbt Cloud, replace
  compiled files with API-backed sources; the naming contract and pages stay.
