# The rubric — every rule, why it exists, how to fix it

Two instruments run against a page. Neither replaces the other.

| Instrument | Runs | Sees | Where |
|-----------|------|------|-------|
| **Page audit** | `npm run dashboard:audit` | Page source: components, props, hexes, prose | `scripts/dashboard-audit.mjs` |
| **Chart audit** | In the page, `showAudit=true` | The *compiled* chart: how many series there actually are, whether it faceted | `components/flint/theme-bridge.js` → `auditOption` |

The chart audit sees things the page audit cannot, because it runs after Flint
has resolved the data. Five series is not visible in the source when the series
column has five distinct values.

**Score** = `100 − 3×errors − warnings`. It exists to be compared between passes
of the loop, nothing more. A score is not a grade; zero errors is the bar.

---

## Page audit rules

### `kpi-needs-comparison` — error

**Checks** every `<BigValue>` for `comparison=` or `sparkline=`.

**Why.** A number with nothing beside it cannot be acted on. "Revenue is $2.4M"
supports no decision; "$2.4M, +8% on the prior period" does. This is the most
common defect in a first draft and the one that most reduces a dashboard to
decoration.

**Fix.** Add a prior-period figure, a target, or a sparkline — usually both a
comparison and a sparkline:

```svelte
<BigValue data={kpi} value=revenue fmt=usd0k
    comparison=revenue_growth comparisonFmt=pct1 comparisonTitle="vs prev period"
    sparkline=metric_time/>
```

The comparison usually needs a `prev` CTE in the query — see
[`pages/index.md`](../../../../pages/index.md) for the pattern.

**Legitimate exception.** A page demonstrating the component itself. Opt out with
`<!-- audit-ignore: kpi-needs-comparison -->`.

---

### `palette-only` — error

**Checks** every 6-digit hex in the page against the hexes in
`evidence.config.yaml`.

**Why.** The palette is a validated instance of the project's colour method: every
adjacent pair clears ΔE ≥ 8 under CVD simulation and ≥ 15 for normal vision, on
both surfaces. A hue added by hand has passed none of those checks, and it breaks
the correspondence that lets a reader carry a colour's meaning from one chart to
the next.

**Fix.** Delete the hex. Series colour comes from slot order automatically. If a
value genuinely needs a fixed colour across pages, that belongs in the theme, not
the page.

---

### `no-dual-axis` — error

**Checks** for `y2=` outside a `Range Area Chart`.

**Why.** Two scales on one plot make the crossing point an artefact of the axis
ranges. The reader sees a relationship that the chart author chose.

**Fix.** Two charts, or index both series to 100 at a base period. `Range Area
Chart`'s `y2` is exempt because it is the far edge of a band on one scale, not a
second scale.

---

### `flint-needs-semantics` — error

**Checks** every `<FlintChart>` for `types=` and `title=`.

**Why.** Semantic types are the entire mechanism — without them Flint sniffs raw
values and the zero baseline, sort order, colour scheme and tick format all become
guesses. The title is where the measure gets named; a chart of bare numbers names
nothing on its own.

**Fix.** → `.claude/skills/flint-chart/references/semantic-types.md`.

---

### `flint-chart-type-exists` — error

**Checks** `chartType=` against the 37 template names.

**Why.** A wrong name throws at render time, in the page, in front of the reader.

**Fix.** Copy the exact string from
`.claude/skills/flint-chart/references/chart-catalog.md`. The audit suggests near
matches.

---

### `flint-semantic-type-exists` — warning

**Checks** every value in `types={{ … }}` against the 44 registered names.

**Why.** An unregistered name is *ignored*, not rejected — the chart renders,
looking fine, with none of the decisions the type was supposed to drive. Silence
is what makes this worth a rule.

**Fix.** Correct the spelling, or drop the column from `types` — Flint's inference
beats a name it does not recognise.

---

### `daterange-bounds` — error

**Checks** that a `<DateRange>`'s backing query returns its two bounds in **one
column** (two rows, via `union all`) rather than as two columns of one row.

**Why.** `DateRange` computes its own `min()`/`max()` over the single column named
by `dates=`. Hand it `select min(d) as start_date, max(d) as end_date` and point
`dates=` at `start_date`, and that column holds exactly one value — the earliest
date. Its min and its max are then the same day, so `defaultValue="Last 30 Days"`
resolves to the thirty days *ending where the data starts*, and every query
downstream of the filter returns nothing.

This is a nasty one because the page still builds, the picker still looks right,
and the failure reads as "the data is missing" rather than "the filter is wrong".

**Fix.**

```sql date_bounds
select min(metric_time) as metric_time from ${metrics_revenue}
union all
select max(metric_time) from ${metrics_revenue}
```

```svelte
<DateRange name=date_range data={date_bounds} dates=metric_time defaultValue="Last 30 Days"/>
```

Two rows carry the same answer as ten thousand without shipping the table to the
browser. [`pages/gallery.md`](../../../../pages/gallery.md) has the canonical version.

---

### `table-reachable` — warning

**Checks** that a page with charts also has a `<DataTable>` or a link.

**Why.** A chart nobody can check is a claim. The rows behind a number are how a
reader resolves a surprise without asking.

**Fix.** Add a `<DataTable>`, or a drill link to a templated page — see
[`pages/regions/[region].md`](../../../../pages/regions/).

---

### `page-states-basis` — warning

**Checks** for a context sentence between the frontmatter and the first
query/component, or a frontmatter `description` of real length.

**Why.** "Revenue" is not a definition. Gross or net, which exclusions, which
currency, which date field — a reader who does not know cannot use the figure, and
two readers will use it differently.

**Fix.** One sentence naming the measure, the exclusions and the units:

> Gross order revenue in USD, **excluding cancelled orders** and internal test
> accounts; not net of refunds.

---

### `numbers-wear-formats` — warning

**Checks** `<Column>` and `<BigValue>` whose id names a measure for a `fmt=`.
Measure-ness is matched against snake_case parts, so `order_count` is a count and
`country_code` is not.

**Why.** A raw float is unreadable and inconsistent between components. Pick a
format once per measure and reuse it everywhere.

**Fix.** `usd0`, `usd0k`, `usd2`, `pct1`, `num0` — the cookbook in
`evidence-bi/references/components.md` has the full list.

---

### `filters-in-one-row` — warning

**Checks** whether inputs are gathered together or scattered down the page.

**Why.** Filters apply top-down over the whole page. A filter below a chart it
controls reads as a filter that does not control it, and the reader mistrusts both.

**Fix.** Move every input into one row above the first chart.

---

## Chart audit rules

Run with `showAudit=true` on the chart, or in `npm run test:flint`.

### `palette-exhausted` — error

More series than the palette has slots. Hues would repeat and two different
categories would share a colour.

**Fix.** Fold the tail into "Other", or facet with `column=`/`row=`.

### `too-many-series` — warning

More than four series. The palette can still cover it, but the legend has outrun
the reader — matching eight lines to eight legend entries is a lookup task, not
reading.

**Fix.** Facet. Small multiples keep every category visible and need no legend.

### `relief-rule` — warning

Light mode, enough series to reach slots 3–5 (aqua `#1baf7a`, yellow `#eda100`,
magenta `#e87ba4`), and no data labels. Those three sit below 3:1 against white.

**Fix.** Turn on labels, or put a `<DataTable>` on the page and set `hasTable=true`
to declare it.

### `dual-axis` — error

Two y-scales sharing one plot, detected after compilation (facet panels, which
legitimately produce several axes, are excluded).

### `unformatted-measure` — warning

The measure axis has no formatter, so the chart is showing raw floats.

**Fix.** `fmt=` on the component.

### `missing-title` — warning

No title. The headline is where the measure gets named.

---

## What neither instrument checks

Both are structural. Neither can tell you:

- the page answers the wrong question
- the metric is right and irrelevant to this reader
- two charts say the same thing
- the default filter hides the interesting case
- the layout collapses at 1280px

That is what the seven critique questions in the loop are for. When a page scores
100 and still reads badly, the failure is in the framing sentence, and no rule
will find it.
