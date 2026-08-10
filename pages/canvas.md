---
title: One Dashboard
description: Every tool in this project on a single board, over one governed metrics view.
---

<Canvas canvas="executive"/>

## What is on this page

Five tools, one board, one scan of one view. The layout is
`canvas/executive.yaml`; nothing above is arranged in code.

| From | What it contributes |
|---|---|
| **dbt** | The marts, and the rule that a measure is defined once. |
| **Rill** | The canvas grammar, the window and the window before it, the KPI row, leaderboards, cross-filtering. |
| **flint-chart** | Every chart. Described by what the columns *mean*, not by chart configuration. |
| **Cube** | The pivot — rows × columns × measures, with real totals. |
| **Notebooks** | One cell whose SQL you can actually run. |

## Why one board rather than five pages

Because the tools stop being separate. Click **EMEA** on the leaderboard and the
KPI row, both charts, the pivot and the notebook cell all narrow — they are
reading the same filtered scan of the same view. Five tools that each own their
filter state make five dashboards on one page, and the reader is the one left to
notice they disagree.

The other half of the same idea: no tile restates a measure. `revenue` is
`sum(order_amount_usd)` in `rill/metrics/orders_metrics.yaml` and nowhere else.
Add a measure there and it appears in the KPI row, the pivot's measure chips, the
leaderboard and the worksheet at once.

## The three things worth looking at closely

**The charts are typed, not configured.** flint-chart is handed `revenue →
Amount`, `region → Region`, `bucket → Date` and derives the rest: axis steps,
where the zero baseline goes, label rotation, when a dense category axis has to
wrap into facets. Those semantic types are inferred from the metrics view by the
generator — `Amount` because the measure declares `format_preset: currency_usd`
— so typing a measure once gives every chart of it a zero baseline. A
temperature would not get one, and that is the whole point of the distinction.

**The pivot's totals are computed, not added.** Look at the *Total* row under
Average order value. It is not the sum of the cells and it is not their mean; it
is `sum(order_amount_usd) / nullif(count(*), 0)` evaluated over the whole slice.
On this data the difference is about 1.3% — small enough to survive review,
large enough to be wrong. One `GROUPING SETS` query returns the cells, the row
totals, the column totals and the grand total, each at its own grain. Nothing is
ever added up. Press **SQL** on the pivot to see it.

**One tile is not governed, and says so.** Everything else shows its SQL and
refuses to let you change it, because a measure a reader can redefine in place
is no longer a governed measure. The notebook cell at the bottom starts from the
board's current window and filters — `{{scan}}` in the layout file is
substituted with them — and then it is yours. Nothing you do there moves a
number above it.

## Where this board stops

- **The pivot emits no intermediate subtotals.** With two dimensions down the
  side you get cells, one total row and the grand total, not a subtotal per
  first-level value. That is a longer grouping-set list, not a hard problem.
- **`x_`-prefixed tiles are this project's, not Rill's.** The prefix is in the
  layout file so nobody expects `rill start` to render the pivot, the
  leaderboard or the notebook cell. [`/rill`](/rill) is the pure-Rill surface.
- **Layout changes need a recompile.** `npm run rill:model` after editing
  `canvas/executive.yaml`; `npm run test:canvas` fails if you forget.
