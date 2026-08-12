---
title: Explore (Rill)
description: A Rill metrics view and explore dashboard, defined in YAML and rendered by Evidence.
---

<RillExplore explore="revenue"/>

## What this page is

[Rill](https://github.com/rilldata/rill) is a BI tool with a particular idea: a
dashboard is a *file*. A metrics view declares dimensions and measures in YAML,
an explore declares which of them are on the board and what it opens on, and the
tool renders that. There is nothing to click into existence and nothing to lose.

That idea travels. The dashboard above is defined in
`rill/metrics/orders_metrics.yaml` and
`rill/explores/revenue.yaml` — real Rill project
files, in Rill's own schema. Running `rill start rill/` renders them in Rill.
This page renders them without it, by compiling the same YAML to DuckDB and
running it in your browser.

Neither rendering is the definition. The YAML is.

```bash
npm run rill:model     # compile rill/ into components/rill/model.generated.js
./rill/up.sh           # or run the real thing at localhost:9009
```

## The three things Rill gets right, kept

**A window and the window before it.** Every measure is shown with its change,
because a revenue figure alone cannot tell you whether it is good. The range is
anchored to the newest row in the data rather than to today — this project's
parquet ends 4 August 2026, and a dashboard that opened on "last 7 days"
relative to the clock would show an empty chart and blame the data.

**Leaderboards that filter.** Every dimension is ranked inside the window;
clicking a value filters the whole board, and the board you clicked keeps
showing its other values so you can add a second. Hover a row for `−` to exclude
instead.

**Expand a measure by a dimension.** The *Expand* button on any leaderboard
splits the chart above it into one line per value — Rill calls this the time
dimension detail, and it is usually where "revenue is up" turns into "revenue is
up in one region and flat everywhere else".

## Where it deliberately differs

Rill's dashboards are read-only by design and so are the panels above: each one
shows the exact SQL it ran, and none of them let you edit it. That is not an
omission. This project's reports open every exhibit for editing because a report
is an argument and a reader should be able to check it. A governed measure is
the opposite kind of object — its entire value is that `revenue` means one thing
on every page — so it is inspectable everywhere and editable nowhere.

The escape hatch under the board is the other half of that bargain: the same
window, as a query that *is* yours, clearly labelled as no longer the governed
figure.

## The same measures, on a worksheet

A metrics view is a field list, and noodle already explores field lists. Pointed
at the same explore, its measures arrive carrying the expression the YAML
declares — so `avg_order_value` on a shelf is
`sum(order_amount_usd) / nullif(count(*), 0)`, not an average of something that
sounds similar. The aggregation menu is closed for those fields and says why.

<Noodle rill={{ explore: 'revenue' }} height={520} fieldListHeight={420}/>

## What `valid_percent_of_total` is doing

Rill lets a measure declare that a share of it is meaningful, and the
leaderboards above show a `%` column only for measures that do. Revenue, orders
and line items add up across a slice. Three do not, and each fails differently:

| Measure | Share shown | Why |
|---|---|---|
| Revenue | yes | Regional revenue sums to total revenue. |
| Orders | yes | So do counts of rows. |
| Customers | no | The same customer can order from two regions; the parts exceed the whole. |
| Average order value | no | The average of averages is not the average. |
| Cancellation rate | no | A ratio has no total to be a part of. |

`scripts/build-rill-model.mjs` refuses to compile a project that claims
`valid_percent_of_total` on an expression that cannot support it, so the table
above is enforced rather than remembered. Switch the active measure to
*Average order value* and the `%` column disappears, with the reason in the
panel footer.
