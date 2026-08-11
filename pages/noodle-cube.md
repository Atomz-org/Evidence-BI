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

<Noodle
    cube={{ apiUrl: 'http://localhost:4000' }}
    initial={{ columns: ['orders.ordered_at'], rows: ['orders.revenue'] }}
    height={400}
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
