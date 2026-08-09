---
title: Explore (governed)
description: The same exploration surface, driven by the Cube semantic layer instead of raw parquet.
full_width: true
---

[/noodle](/noodle) explores the **tables**. This page explores the **model**.

The difference is where a number's meaning lives. On the parquet-backed surface,
dropping `Order Amount USD` on Rows produces `sum(order_amount_usd)` because the
shelf decided to sum it. Here, `Revenue` arrives from Cube already knowing it is
a sum, already formatted as currency, and already carrying the description the
model author wrote. The shelf cannot override it — the aggregation control is
disabled for modelled measures and says why.

That is the whole point of a semantic layer: the exploration surface stops being
a place where definitions are invented.

One board, four views, every one of them editable. Press **Edit** on a tile and
the full shelf surface opens over the canvas — the same Show Me, the same marks,
the same level-of-detail expressions as [/noodle](/noodle), except the catalog is
Cube's model rather than the warehouse. Click a mark to cross-filter the rest of
the board; **Publish as code** turns the whole thing into an Evidence page whose
numbers still resolve through the model.

The four starting views each show something the model contributes that the
parquet surface cannot: a measure that carries its own aggregation, a modelled
dimension, a derived measure with no column behind it, and a join nothing on the
page had to declare.

<Studio
    cube={{ apiUrl: 'http://localhost:4000' }}
    storageKey="noodle.studio.cube.v1"
    starter={{
        version: 1,
        title: 'Governed exploration',
        subtitle: 'Four views on the Cube model — press Edit on any tile to open its worksheet',
        mode: 'dashboard',
        filters: [],
        tiles: [
            {
                id: 'tile_1',
                title: 'Revenue over time',
                w: 6, h: 260,
                spec: {
                    source: { primary: null, joins: [] },
                    columns: [{ key: 'c1', fieldId: 'orders.ordered_at', role: 'dimension', agg: null, datePart: 'month', bin: null, sort: null, calc: null, lod: null, format: null }],
                    rows: [{ key: 'c2', fieldId: 'orders.revenue', role: 'measure', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }],
                    color: null, size: null, label: null, detail: [], tooltip: [], filters: [],
                    mark: 'line', stacked: true, limit: 5000
                }
            },
            {
                id: 'tile_2',
                title: 'Revenue by region',
                w: 6, h: 260,
                spec: {
                    source: { primary: null, joins: [] },
                    columns: [{ key: 'c3', fieldId: 'orders.region', role: 'dimension', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }],
                    rows: [{ key: 'c4', fieldId: 'orders.revenue', role: 'measure', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }],
                    color: null, size: null, label: null, detail: [], tooltip: [], filters: [],
                    mark: 'bar', stacked: true, limit: 5000
                }
            },
            {
                id: 'tile_3',
                title: 'Average order value by region',
                w: 6, h: 260,
                spec: {
                    source: { primary: null, joins: [] },
                    columns: [{ key: 'c5', fieldId: 'orders.region', role: 'dimension', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }],
                    rows: [{ key: 'c6', fieldId: 'orders.avg_order_value', role: 'measure', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }],
                    color: null, size: null, label: null, detail: [], tooltip: [], filters: [],
                    mark: 'bar', stacked: true, limit: 5000
                }
            },
            {
                id: 'tile_4',
                title: 'Revenue by country — a join from the model',
                w: 6, h: 260,
                spec: {
                    source: { primary: null, joins: [] },
                    columns: [{ key: 'c7', fieldId: 'customers.country_code', role: 'dimension', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }],
                    rows: [
                        { key: 'c8', fieldId: 'orders.revenue', role: 'measure', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null },
                        { key: 'c9', fieldId: 'orders.count', role: 'measure', agg: null, datePart: null, bin: null, sort: null, calc: null, lod: null, format: null }
                    ],
                    color: null, size: null, label: null, detail: [], tooltip: [], filters: [],
                    mark: 'table', stacked: true, limit: 5000
                }
            }
        ]
    }}
/>

<Alert status="info">

This page needs a local Cube. Run <code>npm run sources</code> then
<code>./cube/up.sh</code>. Without it the panel reports that it could not reach
the model rather than falling back to ungoverned numbers — which is the correct
failure for a governed surface.

</Alert>

## What Cube contributes

**Aggregation belongs to the measure.** `revenue` is `sum(order_amount_usd)`,
`avg_order_value` is `{revenue} / nullif({count}, 0)` — a derived measure that
cannot be reconstructed by aggregating a column, and which therefore has no
meaning at all on the parquet surface. Both are just fields here.

**Joins come from the model.** Cube publishes a `connectedComponent` per cube,
so noodle knows `orders` and `customers` are reachable from one another and can
say so before you drag. Two cubes with no path between them are refused with a
reason instead of producing a Cube planning error.

**Segments are named filters with definitions.** `not_cancelled` is
`order_status <> 'cancelled'` written once in the model. Applying it here
reduces EMEA revenue from 198,756.65 to 188,937.71 — and applies the identical
predicate in a notebook, in `sources/`, and on every other dashboard.

## The same model, three ways

The value only shows up when the definition is shared, so it is reachable from
all three surfaces:

```python
# a notebook — same measure, same segment, same number
df = evidence.cube({
    "measures": ["orders.revenue"],
    "dimensions": ["orders.region"],
    "segments": ["orders.not_cancelled"],
})
```

```sql
-- sources/, through Cube's Postgres-wire SQL API
select region, MEASURE(revenue) as revenue
from orders group by 1
```

**Copy as Evidence markdown** on this page emits the SQL form, so a view built
by dragging becomes a governed page that still resolves through the model.

One hazard worth knowing before you use the SQL API for anything with a date in
it: node-postgres localises `timestamp without time zone`, which can file July's
revenue under June depending on the build machine's timezone. The cause and the
fix are in [cube/README.md](https://github.com/PackMaaan/cube) — see the
project's `cube/README.md`, *The timestamp trap*.

## Where this sits

Exploration is still exploration. A view built here is a question; the answer of
record is a dbt metric rendered on a reviewed page. What Cube changes is that
the question is now asked in the vocabulary of the model, so the step from
"interesting" to "governed" no longer involves re-deriving what a number meant.

See the [Metric Dictionary](/metrics) for what is defined today.
