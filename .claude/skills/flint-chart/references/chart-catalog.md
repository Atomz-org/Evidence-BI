# Chart catalog — the 37 ECharts templates

Generated from `ecTemplateDefs` in `flint-chart@0.5.0`. Regenerate after an
upgrade:

```bash
node --input-type=module -e "
import { ecTemplateDefs } from 'flint-chart';
for (const [cat, defs] of Object.entries(ecTemplateDefs))
  for (const d of defs) console.log([cat, d.chart, d.channels.join(' ')].join(' :: '));
"
```

**Chart type names are exact strings.** `"Bar Chart"` is a template; `"bar"`,
`"Bar"` and `"Column Chart"` are not, and the audit rejects them.

## Reading the channel lists

`x`, `y` and `series` are `<FlintChart>` props. Everything else goes through
`encodings={{ … }}`. Flint's own name for the series channel is `color`, which is
what `series=` sets.

| Channel | What it carries |
|---------|-----------------|
| `x`, `y` | Position — the two channels the eye reads most accurately |
| `color` | The series split. Categorical on most templates, the measure on Heatmap/Treemap |
| `group` | Side-by-side placement within a category (Grouped Bar only) |
| `size` | Magnitude on an area or radius. Weaker than position — never the only encoding of the point |
| `detail` | Splits marks without giving them a hue: one line per customer, one path per order |
| `order` | Explicit path order for a connected mark |
| `column`, `row` | Faceting. Flint decides the grid, wraps it, and shares the axes |
| `opacity` | Density relief on overplotted marks |
| `y2`, `x2` | The far end of a band or span — a range, not a second scale |
| `open/high/low/close` | Candlestick's four required price channels |
| `goal` | Bullet chart's target line |

A channel a template does not list is ignored silently. A required channel left
empty throws visibly in the page — read the message, it names the template and
the channel.

## By the job the chart does

### Change over time

| Chart | Channels | Use when |
|-------|----------|----------|
| `Line Chart` | x y color opacity column row | The default for a time series. Continuous x, one line per series |
| `Area Chart` | x y color opacity column row | Volume matters as much as level. Stacks via `stackMode` |
| `Streamgraph` | x y color column row | Composition shifting over time, no meaningful zero baseline |
| `Range Area Chart` | x y y2 color column row | A band: forecast interval, min/max, target corridor. `y2` is the far edge, **not** a second scale |
| `Bump Chart` | x y color detail column row | Rank over time, when position in the order is the story and the value is not |
| `Slope Chart` | x y color detail column row | Exactly two time points. Shows who moved and by how much |
| `Calendar Heatmap` | x color | Daily values over a year, when weekday and seasonal patterns matter |

Properties worth knowing: `Line Chart` takes `interpolate` and `showPoints`;
`Area Chart` adds `opacity` (0.7) and `stackMode`.

### Magnitude comparison

| Chart | Channels | Use when |
|-------|----------|----------|
| `Bar Chart` | x y color opacity column row | One measure across categories. `color` **stacks** — it does not group |
| `Grouped Bar Chart` | x y group color column row | Two categorical splits side by side. The `group` channel is what separates the bars |
| `Stacked Bar Chart` | x y color column row | Parts within each category, when the total also matters |
| `Lollipop Chart` | x y color column row | Many categories, thin marks. Less ink than bars at high cardinality |
| `Pyramid Chart` | x y color | Two opposed populations (age × sex is the canonical one) |
| `Waterfall Chart` | x y color column row | How a total was reached — bridge from opening to closing balance |
| `Bullet Chart` | y x goal color column row | Actual against target. `goal` draws the reference |
| `Radar Chart` | x y color column row | A handful of comparable measures on one shape. Hard to read past ~3 series |
| `Rose Chart` | x y color column row | Cyclic categories (months, compass points) where the cycle is the point |

**`Bar Chart` vs `Grouped Bar Chart` is the most common mistake.** If you want
bars beside each other, you need `Grouped Bar Chart` and the `group` channel;
putting a second category on `color` in `Bar Chart` stacks it.

### Composition

| Chart | Channels | Use when |
|-------|----------|----------|
| `Pie Chart` | size color column row | Up to ~5 slices, when the shares are far apart. Otherwise use a bar |
| `Funnel Chart` | y size | Ordered stages with drop-off between them |
| `Treemap` | color size detail | Nested parts of a whole, many leaves, area is the measure |
| `Sunburst Chart` | color size detail group | Hierarchy where the depth matters as much as the size |
| `Tree` | color detail size | Structure itself is the subject — org charts, taxonomies |

`Pie Chart` properties: `innerRadius` (a donut), `sortSlices`, `labelType`
(default `"categoryPercent"`).

### Distribution

| Chart | Channels | Use when |
|-------|----------|----------|
| `Histogram` | x color column row | One measure's shape. `binCount=0` lets Flint choose |
| `Density Plot` | x color column row | Same, smoothed — better for comparing several distributions |
| `Boxplot` | x y color opacity column row | Distribution per category, when outliers matter. `whiskerMethod="iqr"` |
| `Strip Plot` | x y color size column row | Small n, where every observation should be visible |
| `ECDF Plot` | x color detail column row | "What share is below X" — reads percentiles directly |

### Correlation and relationship

| Chart | Channels | Use when |
|-------|----------|----------|
| `Scatter Plot` | x y color size opacity column row | Two measures. Add `size` for a third, sparingly |
| `Regression` | x y size color column row | Same, with a fitted line. `regressionMethod="linear"`, `polyOrder=3` |
| `Connected Scatter Plot` | x y order color detail column row | Two measures moving together through time; `order` is the path |
| `Ranged Dot Plot` | x y color | Two points per category — before/after, actual/target |
| `Heatmap` | x y color column row | Two dimensions, measure on colour. Uses the sequential ramp |
| `Parallel Coordinates` | color detail | Many measures per record, looking for clusters |

### Flow and structure

| Chart | Channels | Use when |
|-------|----------|----------|
| `Sankey Diagram` | x y size | Volume moving between stages or states |
| `Network Graph` | x y size | Entities and their links, when the topology is the subject |
| `Gantt Chart` | y x x2 color detail column row | Spans over time. `x` starts, `x2` ends |

### Financial and indicator

| Chart | Channels | Use when |
|-------|----------|----------|
| `Candlestick Chart` | x open high low close column row | OHLC series. All four price channels are required. `showMA`, `maWindow=5` |
| `Gauge Chart` | size column | A single value against a fixed range. `min=0`, `max=100` |

**A `Gauge Chart` is almost never the right answer in this project.** One number
against a range is a `BigValue` with `comparison=` — it reads faster, prints
better and carries the delta. Reach for the gauge only when the range itself is
the subject (a utilisation ceiling, an SLA band).

## Faceting

`column` and `row` are available on most templates. Hand Flint the field and it
decides the grid: how many panels fit, how to wrap them, which panels keep their
axis titles, how to share the x-axis title across the bottom.

```svelte
encodings={{ column: 'region' }}
```

Facets are usually the right answer above four series — every category stays
visible, and no hue has to work harder than the palette allows.

Flint drops panels beyond its facet budget (12 on most templates) rather than
rendering an unreadable grid. If panels are missing, the cardinality is too high:
aggregate first.
