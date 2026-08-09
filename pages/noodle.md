---
title: Explore
description: Drag fields onto shelves to build a view; take the result away as Evidence markdown.
# A workbench, not a document: three panels and a chart need the whole width.
full_width: true
---

Every other page in this project is a **published** answer — a metric, a chart, a
report, reviewed and versioned. This page is the other half: the place to ask a
question nobody has written down yet.

Drag a field onto **Columns**, a measure onto **Rows**. The shelves are the
specification; the SQL and the chart are both derived from it, so the mark can
change without touching the query and the query can change without touching the
mark. **Show Me** ranks the marks that suit the fields you have chosen and says
why. Click any mark on the chart to filter to it.

When a view is worth keeping, **Copy as Evidence markdown** hands you the `sql`
block and the component — paste it into a page and it becomes governed like
everything else. Exploration is interactive; the result is code.

<Noodle
    tables={['dbt_semantic.orders', 'dbt_semantic.customers']}
    relationships={[
        {
            from: 'dbt_semantic.orders',
            to: 'dbt_semantic.customers',
            on: [['customer_id', 'customer_id']],
            type: 'left'
        }
    ]}
    fields={{
        'dbt_semantic.customers.region': { name: 'Customer Region' },
        'dbt_semantic.orders.net_line_amount_usd': { name: 'Net Line Amount' },
        'dbt_semantic.orders.line_item_count': { name: 'Line Items', format: 'num0' }
    }}
    initial={{ columns: ['dbt_semantic.orders.ordered_date'], rows: ['dbt_semantic.orders.order_amount_usd'] }}
    height={400}
/>

## What the shelves actually do

**Granularity is the whole game.** A view's grain is the set of dimensions on its
shelves; measures aggregate up to it. Drop `Region` on Columns and
`Order Amount USD` on Rows and you get revenue per region — not because a chart
type was chosen, but because the grain changed.

**Level-of-detail expressions** exist for the numbers that must be computed at a
*different* grain and then brought back — a region's total shown against each of
its months, a customer's lifetime value shown on a single order. `FIXED` ignores
the view's grain, `INCLUDE` adds to it, `EXCLUDE` subtracts from it. Each one
compiles to its own grouped query, paired distinctly with the view's grain, then
aggregated in — which is why an `AVG` over an LOD is the mean of the inner
results and not a row-weighted mean of the underlying rows.

**Table calculations** — running total, moving average, percent of total, rank —
are computed over the result, along a **field** rather than along the screen.
That is deliberate: a calculation addressed to "across the table" changes meaning
the moment Rows and Columns are swapped. Addressed to a date, it means the same
thing in every layout.

## The relationship layer

Tables are linked logically and joined only when a view actually reaches across
them, so an unused dimension table can never change a measure's grain. The links
above come from the dbt semantic model — the same one that defines every metric
in `/metrics`. A field whose table has no declared path to the view's primary
table is reported rather than silently cross-joined.

Two layers are live today: the logical **relationship** layer and the physical
**join** it resolves to. Blending genuinely separate sources — aggregating each
to a common grain and matching on shared dimensions, for warehouses that cannot
be joined at all — is not built yet; see the README for where that sits.

## This is exploration, not governance

Anything built here is a question, not an answer of record. Numbers on this page
carry no metric definition behind them: an ad-hoc `Sum of Order Amount USD` is
not the governed `revenue` metric, which excludes cancelled orders and test
accounts. If a view here turns out to matter, the path is the same as always —
export it, and if it needs a new number, that number becomes a dbt metric first.

See the [Metric Dictionary](/metrics) for what is already defined, and the
[Revenue Overview](/) for the governed versions of these figures.
