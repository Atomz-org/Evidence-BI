---
name: evidence-bi
description: >
  Use this skill whenever you build or edit anything in this Evidence project —
  a page, a chart, a KPI tile, a filter, a query, or the theme — and whenever you
  wire dbt semantic-layer metrics (MetricFlow _metrics.yml / _semantic_models.yml)
  into Evidence. It encodes the design principles that make this project compete
  with Looker and Power BI: a metric-first workflow, a validated color system,
  dashboard grammar, and a mechanical dbt→Evidence compilation contract.
  Triggers: "dashboard", "chart", "KPI", "BigValue", "metric", "semantic layer",
  "dbt metrics", "Evidence page", "theme", "palette", "drill-down", "filter".
---

# Evidence BI — design principles and semantic-layer method

This project is BI-as-code: dbt owns the **facts and metric definitions**, Evidence
owns the **presentation**. Every dashboard is right by construction when you follow
the two contracts below — the *semantic contract* (what a number means) and the
*design contract* (how it is shown).

## The procedure — in order

1. **Start from the metric, never from the chart.** Every number on a page traces
   to a dbt metric in `models/semantic/_metrics.yml` (mirrored here as
   `queries/metrics/<metric_name>.sql`). If the number you need has no metric, the
   fix is a dbt PR, not ad-hoc SQL in a page. → `references/dbt-semantic-layer.md`
2. **Pick the form by the data's job** — headline, change-over-time, magnitude
   comparison, composition, distribution, or lookup. The job picks the Evidence
   component; sometimes the answer is a `BigValue` or a `DataTable`, not a chart.
   → `references/design-principles.md` § Choosing a form
3. **Compose the page with the standard anatomy**: title + context sentence →
   one filter row → KPI row → primary trend → breakdowns → detail table with
   drill links. Never a wall of charts. → `references/design-principles.md` § Page anatomy
4. **Color by job, from the theme only.** The palette in `evidence.config.yaml`
   is validated (CVD-safe, contrast-checked, light and dark) — never introduce
   hex values outside it. Categorical hues keep fixed order; sequential = one hue;
   diverging = blue↔red around gray; status colors are reserved.
   → `references/design-principles.md` § Color
5. **Use the component cookbook** for exact, working syntax (props, fmt strings,
   inputs, templated drill pages). → `references/components.md`
6. **Check against the anti-pattern list** before you're done, then run
   `npm run dashboard:audit` and `npm run build` — the audit checks the
   non-negotiables below mechanically, and a broken query fails the build, which
   is the point of BI-as-code. → `references/design-principles.md` § Anti-patterns

## Non-negotiables

- **One metric, one definition.** Page SQL may *filter, aggregate, or join*
  metric queries (`from ${revenue}`); it may never restate business logic
  (status exclusions, test-account filters, fill rules). Those live in dbt YAML
  and in the compiled `queries/metrics/*.sql` only.
- **One axis.** Never two y-scales on one chart (no `y2` for a second unit).
  Two measures of different scale → two charts or an indexed series.
- **Fixed hue order, never cycled.** More than ~4 series on one chart → fold the
  tail into "Other" or facet. A 9th hue is never invented.
- **Comparisons or it didn't happen.** A KPI without a reference (previous
  period, target, or trend sparkline) is a decoration. Every `BigValue` carries
  `comparison=` or `sparkline=` (usually both).
- **The table is always reachable.** Every chart's data must be inspectable —
  a `DataTable` on the page or a drill page one click away.
- **Filters live in one row above the charts**, apply top-down, and every page
  states its exclusions in a subtitle (e.g. "excludes cancelled orders").
- **Light-mode relief rule**: aqua `#1baf7a`, yellow `#eda100`, magenta `#e87ba4`
  sit below 3:1 on white — a chart leaning on those slots ships visible labels
  or a table view alongside.
- **Numbers wear formats.** Never a raw float on screen: `usd0`, `usd0k`,
  `pct1`, `num0` — pick once per measure and reuse everywhere (see cookbook).

## The dbt → Evidence pipeline (this project)

```
dbt build (example-order-revenue-mart)          # marts + tests in dev.duckdb
./scripts/sync-dbt.sh                           # copies dev.duckdb → sources/dbt_semantic/
npm run sources                                 # Evidence extracts marts to parquet
npm run dev                                     # dashboards on localhost:3000
```

`queries/metrics/*.sql` is the compiled semantic layer: one file per dbt metric,
same name, `metric_time` + dimension columns + the metric value. The compilation
rules for every MetricFlow metric type (simple, ratio, derived, cumulative) are
mechanical — see `references/dbt-semantic-layer.md`.

## Reference files

| File | What it answers |
|------|-----------------|
| `references/design-principles.md` | Form choice, page anatomy, color system, anti-patterns |
| `references/components.md` | Exact Evidence syntax for every job (KPIs, filters, drills, tables) |
| `references/dbt-semantic-layer.md` | The dbt→Evidence contract: sync, compilation rules, governance |
| `references/enterprise-reporting.md` | Management/board packs: control block, accounting formats, comparatives, materiality, print |

## Companion skills

| Skill | When |
|-------|------|
| `.claude/skills/flint-chart` | Authoring a chart with `<FlintChart>` — semantic types, the 37-template catalog, which channels each accepts. The semantic path to a chart; Evidence's own components remain right when the form is already decided |
| `.claude/skills/dashboard-loop` | The ask is open-ended about quality ("world-class", "improve this page"). Draft → score → critique → fix → repeat, with `npm run dashboard:audit` as the stopping criterion |

The non-negotiables above are what the audit checks. When a rule and this file
disagree, this file wins and the rule is wrong.

**Dashboard or report?** A dashboard is scanned and operated; a report is circulated,
cited and archived. Both share this palette and this metric contract, but a report also
carries a control block, a basis of preparation, numbered exhibits with source lines, and
accounting number formats (adverse values in parentheses). When the ask is a management
pack, board pack, MI, or anything destined for PDF, read
`references/enterprise-reporting.md` as well.
