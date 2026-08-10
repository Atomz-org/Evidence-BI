---
name: flint-chart
description: >
  Use this skill when authoring a chart in this Evidence project with
  <FlintChart> — the semantic charting path built on flint-chart. It covers
  choosing a chart type from the 37-template catalog, assigning semantic types
  (the prop that actually drives layout), which channels each chart accepts,
  how colour is applied from the project palette rather than from Flint, and
  how to read the built-in audit. Triggers: "FlintChart", "flint", "semantic
  chart", "chart type", "semantic types", "facet", "small multiples",
  "which chart should this be", "chart won't render", "chart looks wrong".
---

# FlintChart — charting from what the data means

Evidence's own components are the right tool when the form is already decided:
`<LineChart>` draws a line and you tune the rest by hand. `<FlintChart>` answers
a different question. You state what the columns **mean** — `Amount`, `Region`,
`Date` — and Flint derives the layout: axis steps, label rotation, legend
placement, when a dense axis has to wrap into facets, how much canvas the chart
needs. Those are the decisions that take longest to get right by hand and are
the first to rot when the data changes shape.

Working reference page: [`pages/flint.md`](../../../pages/flint.md) — every
pattern below is live there against real project data.

## The one rule that matters most

**Always pass `types`.** Semantic types are the whole mechanism. Without them
Flint sniffs raw values and falls back to `number → quantitative,
string → nominal`, which throws away every decision that made the library worth
using: zero baselines, sort order, colour scheme selection, tick formatting,
whether a scale is cyclic, whether a domain is bounded.

```svelte
types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
```

`Amount` says money, so zero is meaningful and the axis starts there. `Region`
says place, so the values are categorical and unordered. `Date` says time, so
the x-scale is temporal and the tick format follows the span. Change nothing but
the chart type and all of that still holds — which is the point of stating it once.

→ the 44 registered types: `references/semantic-types.md`

## The procedure

1. **Pick the job before the chart.** Change over time, magnitude comparison,
   composition, distribution, correlation, flow, or lookup. The job narrows the
   catalog to two or three candidates; the data's cardinality picks between them.
   This is the same first step as `evidence-bi` § Choosing a form — a `BigValue`
   or `DataTable` is often still the right answer.
2. **Look the chart type up in the catalog** and copy the name exactly. `"Bar
   Chart"` stacks via `color`; `"Grouped Bar Chart"` puts bars side by side via
   `group`. Those are different templates, not one template with a flag.
   → `references/chart-catalog.md`
3. **Fill only the channels that template accepts.** A channel the template does
   not list is ignored silently; a required channel left empty throws, visibly,
   in the page. `x`, `y` and `series` are props; everything else goes through
   `encodings={{ … }}`.
4. **Assign a semantic type to every column you encode.**
5. **Give it a `title` and a `fmt`.** The headline is where the measure gets
   named. `fmt` is an Evidence format code (`usd0k`, `pct1`, `num0`) and it
   reaches the axis, the tooltip and the data labels together.
6. **Check the audit** — `showAudit=true` while building, `npm run dashboard:audit`
   before you are done.

## Props

| Prop | What it does |
|------|--------------|
| `data` | An Evidence query result, or any array of row objects |
| `chartType` | A catalog name, spelled exactly: `"Line Chart"`, `"Waterfall Chart"` |
| `x`, `y`, `series` | The three common channels. `series` is this project's word for Flint's `color` |
| `encodings` | Every other channel: `{{ column: 'region', size: 'orders', y2: 'high' }}` |
| `types` | column → semantic type. Not optional in practice |
| `labels` | column → display label, for axis titles and the legend header |
| `fmt` | Evidence format code for the measure |
| `formats` | Per-channel override when x and y carry different units: `{{ x: 'num0', y: 'usd0k' }}` |
| `title`, `subtitle` | Headline and deck. Rendered in the DOM, so they stay selectable |
| `height` | Target plot height in px. Width is always the container's |
| `grow` | Let Flint exceed `height` when the data is dense (default `true`) |
| `properties` | Flint template properties: bar corner radius, opacity, showLabels |
| `hasTable` | Declare that a companion `DataTable` is on the page — satisfies the relief rule |
| `showAudit` | Print rule violations under the chart while building |

## Colour is not Flint's

Flint ships ten theme presets (`economist`, `swiss`, `nature`, …) through
`theme_spec`. **They do nothing here.** That field is realized by Flint's
Vega-Lite assembler only; the ECharts assembler accepts it and ignores it, so an
option arrives wearing stock ECharts hues that are not CVD-checked against this
project's surfaces.

So `components/flint/theme-bridge.js` runs after assembly and re-inks every
option from the validated eight-slot palette in `evidence.config.yaml` — the
same palette Evidence's own charts and the Noodle engine use. Series *n* is
always palette slot *n*, because slot **order** is the CVD-safety mechanism.

What this means when authoring:

- **Never set a colour.** Not in `properties`, not in `encodings`, not as a hex
  anywhere on the page. The audit fails a page that does.
- **Never ask for a Flint theme preset.** It will be silently ignored, which is
  worse than an error because the chart still renders.
- **Above four series, fold or facet.** Eight slots exist; past four the legend
  outruns the reader. `column=`/`row=` is usually better than an "Other" bucket
  because it keeps every category visible.
- **Light mode, 3+ series** reaches the aqua/yellow/magenta slots, which sit
  below 3:1 on white. Ship labels or a companion table and set `hasTable=true`.

## What Flint decides, and how to argue with it

Flint owns layout. When a chart looks wrong the fix is almost always upstream of
the layout, not a layout override:

| Symptom | The actual cause | Fix |
|---------|------------------|-----|
| Axis labels rotated 90°, chart very tall | Too many categories for the width | Aggregate to fewer categories, or facet |
| Chart much bigger than `height` | Flint grew the canvas under pressure | Reduce the data's cardinality, or `grow=false` to cap it |
| Axis does not start at zero | Semantic type says zero is not meaningful (`Temperature`, `Score`, `Rank`) | Correct the type if the column really is an `Amount` |
| Categories in the wrong order | Type has no inherent order | Use an ordinal type (`Month`, `Quarter`) or sort in SQL |
| Dates read as strings | Column is a string and no type was given | `types={{ col: 'Date' }}` |
| Bar chart x-axis shows raw ISO timestamps | A `Date` on a *band* axis has no tick formatter — bars need discrete categories | Format the date in SQL (`strftime(week, '%b %d') as week`) and type it `Category`, or use a `Line`/`Area Chart` |
| Nothing renders, red message under the chart | A required channel is missing or the type name is wrong | Read the message — it names the template and the channel |

Two Flint behaviours the component already compensates for, so they should not
reach a page — noted because the symptoms are recognisable if the compensation
is ever removed:

- **The planned canvas exceeds the container.** `canvasSize` caps the plot area;
  axis labels, the legend and a canvas buffer are added *outside* it, so
  `_width` routinely comes back larger than the box. Drawn as-is it clips the
  legend text and the last facet panel. The component hands the overflow back and
  recompiles until it fits.
- **A partial legend when faceting by the colour field.** `column=region` with
  `series=region` makes Flint emit a legend containing one of the three series.
  The bridge drops it — the panels are titled, and a key that names a third of
  the series mis-labels the rest.

**Reshape in SQL, not in the chart.** Flint is a chart compiler, not a
data-wrangling layer: no transforms, no calculated fields, no derived columns.
Filter, aggregate and pivot in the query block above the chart — which in this
project means starting from a metric in `queries/metrics/` and narrowing it.

## Reference files

| File | What it answers |
|------|-----------------|
| `references/chart-catalog.md` | All 37 chart types, their channels, and which job each is for |
| `references/semantic-types.md` | All 44 semantic types, what each implies, and how to pick |
| `references/recipes.md` | Working `<FlintChart>` blocks for the common jobs |

## Related

- `.claude/skills/evidence-bi` — the metric contract, page anatomy, colour method
  and the non-negotiables this skill inherits. Read it first for anything that is
  not chart-shaped.
- `.claude/skills/dashboard-loop` — the build → score → fix cycle these charts
  are meant to be authored inside.
- `npm run test:flint` — asserts the palette, chrome and formats actually reach
  the rendered option. Run it after touching `components/flint/theme-bridge.js`.
