# A worked example — 76/100 to clean

A real trace, not an illustration. Every audit output below is copied verbatim
from a run of `scripts/dashboard-audit.mjs` against the page at that pass.

**The frame:** *a regional sales lead opens this weekly to decide which region
needs attention.*

---

## Pass 1 — the draft

The first draft is deliberately what a first draft looks like: the data is right,
and almost nothing else is.

```markdown
---
title: Regional Performance
queries:
  - saved/weekly_revenue_by_region.sql
---

```sql weekly
select week, region, revenue, order_count from ${saved_weekly_revenue_by_region}
```

<BigValue data={weekly} value=revenue fmt=usd0k title="Revenue"/>
<BigValue data={weekly} value=order_count title="Orders"/>

<FlintChart
    data={weekly}
    chartType="Line"
    x=week y=revenue series=region
/>

<Dropdown name=region data={weekly} value=region title="Region"/>

<LineChart data={weekly} x=week y=revenue y2=order_count seriesColors={{EMEA: '#ff0088'}}/>
```

### Score

```
  warn     1  [table-reachable] 2 chart(s) and no DataTable or drill link. Every chart's rows must be inspectable — add a table or a drill page one click away.
  warn     6  [page-states-basis] No context sentence. State what the page measures and what it excludes ("excluding cancelled orders") before the first number, or put it in the frontmatter description — a reader who does not know the basis cannot use the figure.
  ERROR   11  [kpi-needs-comparison] BigValue "revenue" has no reference. Add comparison= (previous period or target) or sparkline=. A number with nothing to compare to is a decoration.
  ERROR   12  [kpi-needs-comparison] BigValue "order_count" has no reference. Add comparison= (previous period or target) or sparkline=. A number with nothing to compare to is a decoration.
  warn    12  [numbers-wear-formats] Measure "order_count" has no fmt. Pick a format once per measure (usd0, usd0k, pct1, num0) and reuse it everywhere — this project never ships a raw float.
  ERROR   14  [flint-needs-semantics] FlintChart without types={{…}}. Semantic types are what Flint reasons from — without them it falls back to sniffing raw values, and the scale, zero-baseline and colour-scheme decisions become guesses.
  ERROR   14  [flint-needs-semantics] FlintChart without a title. The headline is where the measure gets named; a chart of bare numbers names nothing on its own.
  ERROR   16  [flint-chart-type-exists] "Line" is not a Flint chart type. Did you mean "Line Chart"? See .claude/skills/flint-chart/references/chart-catalog.md.
  ERROR   22  [palette-only] Hex #ff0088 is not in the validated palette. Colour comes from evidence.config.yaml — series by slot order, status colours reserved for deltas and alerts.
  ERROR   22  [no-dual-axis] Second y-scale on one chart. Two measures of different scale → two charts, or index both to 100. (Range Area Chart's y2 is a band, not a second scale.)

1 page(s) · 7 error(s) · 3 warning(s) · score 76/100
```

### Critique

Question 1 already fails: **the top of the page does not answer the framing
question.** A regional lead needs to know *which region needs attention*, and the
page opens with a company-wide total. That is a structural problem, not a styling
one, and it outranks all ten findings.

Everything below question 1 is left unanswered this pass — fixing the frame
changes what the rest of the page should be.

---

## Pass 2 — the frame

The KPI row keeps its place (a lead does want the total for context), but the
page's spine becomes per-region: a filter that defaults to all regions, a
per-region trend, and a table that can be sorted by region.

The dual-axis chart is deleted rather than fixed. It was answering "how do
revenue and orders move together", which is not the framing question, and two
charts answering different questions is better than one answering neither.

That is one structural change. Re-score before anything else.

```
  ERROR   20  [kpi-needs-comparison] BigValue "revenue" has no reference. …
  ERROR   21  [kpi-needs-comparison] BigValue "order_count" has no reference. …
  warn    21  [numbers-wear-formats] Measure "order_count" has no fmt. …
  ERROR   23  [flint-needs-semantics] FlintChart without types={{…}}. …
  ERROR   23  [flint-needs-semantics] FlintChart without a title. …
  ERROR   25  [flint-chart-type-exists] "Line" is not a Flint chart type. Did you mean "Line Chart"? …

1 page(s) · 5 error(s) · 3 warning(s) · score 82/100
```

Both errors on line 22 are gone because the chart carrying them is gone. This is
the usual pattern: a structural fix retires findings that would each have been
"fixed" individually, which is why the loop fixes one *highest-cost* thing rather
than the most things.

---

## Pass 3 — wrong numbers, then missing comparisons

Cost order says the wrong number comes first. There is one here that the audit
cannot see: `${saved_weekly_revenue_by_region}` was queried with no date bound,
so the KPI sums all history and the "weekly" trend runs to the beginning of the
data. The filter row fixes the trend; the KPI needs a bounded period and a
prior-period CTE to have something to compare against at all.

```sql
with bounds as (select max(week) as latest from ${weekly}),
     cur as (select sum(revenue) as revenue, sum(order_count) as order_count
             from ${weekly}, bounds
             where week > latest - interval 12 week and week <= latest),
     prev as (select sum(revenue) as revenue
              from ${weekly}, bounds
              where week > latest - interval 24 week and week <= latest - interval 12 week)
select cur.revenue, cur.order_count,
       (cur.revenue - prev.revenue) / nullif(prev.revenue, 0) as revenue_growth
from cur, prev
```

Both windows are twelve weeks and neither overlaps the other, which is the part
that is easy to get wrong: a "current" figure over all history compared against a
"prior" figure over most of that same history is not a period-on-period change,
it is two different periods divided by each other. Same duration, adjacent, half
open at the same end — then the ratio means something.

With `revenue_growth` available, both `BigValue`s get a reference — a comparison
on revenue, a sparkline on orders.

```
  warn     1  [table-reachable] 1 chart(s) and no DataTable or drill link. …
  warn     6  [page-states-basis] No context sentence. …
  ERROR   35  [flint-needs-semantics] FlintChart without types={{…}}. …
  ERROR   35  [flint-needs-semantics] FlintChart without a title. …
  ERROR   37  [flint-chart-type-exists] "Line" is not a Flint chart type. Did you mean "Line Chart"? …

1 page(s) · 3 error(s) · 2 warning(s) · score 89/100
```

`numbers-wear-formats` cleared as a side effect — the `fmt=num0` that the KPI
rewrite needed anyway was the fix. Findings overlap more than the list suggests.

---

## Pass 4 — the remaining findings

What is left is mechanical, and mechanical findings can be batched: the chart
type spelled correctly, `types` and a `title` on each chart, `fmt` on the order
count, a context sentence, a `DataTable`.

```markdown
Gross order revenue in USD, **excluding cancelled orders**; guest checkouts carry
no region and are excluded. Not net of refunds.

<Dropdown name=region data={region_list} value=region multiple=true selectAllByDefault=true title="Region"/>

<Grid cols=2>
    <BigValue data={kpi} value=revenue fmt=usd0k title="Revenue"
        comparison=revenue_growth comparisonFmt=pct1 comparisonTitle="vs prior 12 weeks"/>
    <BigValue data={kpi} value=order_count fmt=num0 title="Orders"
        sparkline=week/>
</Grid>

<FlintChart
    data={weekly}
    chartType="Line Chart"
    x=week y=revenue series=region
    types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
    fmt=usd0k
    title="Weekly revenue by region"
    subtitle="USD, excludes cancelled orders and guest checkouts"
    hasTable=true
/>

<FlintChart
    data={weekly}
    chartType="Line Chart"
    x=week y=order_count series=region
    types={{ week: 'Date', region: 'Region', order_count: 'Count' }}
    fmt=num0
    title="Weekly orders by region"
    subtitle="Order count, same basis"
    hasTable=true
/>

<DataTable data={weekly} rows=12 search=true>
    <Column id=week fmt="mmm d, yyyy" title="Week"/>
    <Column id=region title="Region"/>
    <Column id=revenue fmt=usd0 title="Revenue"/>
    <Column id=order_count fmt=num0 title="Orders"/>
</DataTable>
```

```
1 page(s) · 0 error(s) · 0 warning(s) · score 100/100  — clean
```

Note the two separate charts where pass 1 had one dual-axis chart. Revenue and
orders are different units; each gets its own plot and its own format.

---

## Pass 5 — the exit check

Zero errors is necessary, not sufficient. Run the seven questions once more and
the build:

1. **Answers the framing question?** Yes — the lead sees each region's trend and
   can sort the table by region.
2. **Every number comparable?** The KPIs carry a comparison and a sparkline. The
   charts show every region against every other, which is the comparison a lead
   needs.
3. **Exclusions stated?** Cancelled orders and guest checkouts, in the context
   sentence.
4. **Each chart earns its space?** Two charts, two units, two questions.
5. **Right form?** Change over time → line. Yes.
6. **Dark mode, 1280px, print?** Checked in the browser with the theme switcher.
7. **Rows reachable?** The `DataTable`, searchable.

```bash
npm run build     # a broken query is a broken page
```

Then stop. The next pass would produce spacing changes.

---

## What the trace shows

- **76 → 82 → 89 → 100** across four passes, with one class of fix per pass.
- The largest single improvement came from a finding **no rule reported** —
  question 1 of the critique. The audit never scored the framing.
- Deleting the dual-axis chart retired two errors at once. Structural fixes
  dominate; that is why cost order beats effort order.
- The mechanical findings — spelling, types, formats — were left to the last pass
  deliberately. Polishing a chart that gets deleted in pass 2 is wasted work.
