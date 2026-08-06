# Design principles

The rules here are design-system-agnostic dataviz method, instantiated for
Evidence. They exist so a dashboard is right by construction — not by taste.

## Choosing a form

Ask what the data's **job** is. The job picks the component:

| Job | Question it answers | Component |
|---|---|---|
| Headline | "What is the number right now?" | `BigValue` (+ comparison + sparkline) |
| Change over time | "Which way is it going?" | `LineChart` (1–4 series) / `AreaChart` (one series, magnitude emphasis) |
| Magnitude comparison | "Which is bigger?" | `BarChart` (horizontal via `swapXY` when labels are long) |
| Composition over time | "What is it made of, per period?" | `BarChart` stacked (≤ 4–5 segments) |
| Share of whole (static) | "What fraction is X?" | `BigValue` with `pct` fmt, or 100%-stacked bar — **not a pie** with > 3 slices |
| Distribution | "How spread out is it?" | `Histogram`, `BoxPlot` |
| Correlation | "Do X and Y move together?" | `ScatterPlot` (≤ 3 series — all-pairs color limit) |
| Density over two dims | "Where is it concentrated?" | `Heatmap`, `CalendarHeatmap` |
| Flow | "Where does it go?" | `SankeyDiagram`, `FunnelChart` |
| Lookup / audit | "What are the exact records?" | `DataTable` (search, links, formats) |

Rules of thumb:

- One number with context beats a chart of one number. A single KPI is a
  `BigValue`, never a one-bar bar chart or a gauge.
- Change-over-time with < 4 points is a table row with a delta, not a line.
- If the reader's task is *look up a value*, it's a table. If it's *see a
  pattern*, it's a chart. When both: chart + detail table below.
- Sparklines (inside `BigValue` or `DataTable` columns) show *shape only* —
  no axes, no labels; the big number beside them carries the value.

## Page anatomy

Every dashboard page has the same skeleton, top to bottom:

1. **Title + context sentence.** One line saying what the page covers and its
   standing exclusions ("Gross revenue, excluding cancelled orders and internal
   test accounts"). Metric descriptions from dbt YAML are the source of this text.
2. **Filter row.** All inputs (`DateRange`, `Dropdown`s) in a single row, before
   any number. Filters apply to everything below them; any chart exempt from a
   filter says so in its subtitle ("all regions").
3. **KPI row.** 3–5 `BigValue`s in a `<Grid>`. The first is the page's primary
   metric. Each carries a comparison (vs previous equal period, vs target) and
   usually a sparkline. `downIsGood` set correctly per metric.
4. **Primary trend.** The main metric over time — the biggest chart, full width.
5. **Breakdowns.** 2-up grid of composition/comparison charts (by region, by
   status, …). Each answers exactly one question, stated in its `title`.
6. **Detail table.** A `DataTable` with drill links. This satisfies the
   "table always reachable" rule and is the lookup path for auditors.

Layout discipline:

- **Reading order = importance order.** Top-left is the most important thing.
- **≤ 6 visuals per page.** More → split into a drill page or `Tabs`.
- **Drill, don't cram.** Overview page → templated detail page
  (`pages/<dim>/[value].md`) via `DataTable` row links or `BigValue link=`.
  This is Evidence's equivalent of Looker drill fields / Power BI drill-through.
- Prose between sections is allowed and encouraged — a sentence explaining *why
  a chart matters* is a feature markdown-BI has and Looker doesn't. Use it.

## Color

The theme in `evidence.config.yaml` is the **only** source of chart color. It was
validated with the dataviz six-check validator against this project's real
surfaces (`#ffffff` light, `#09090b` dark): lightness band, chroma floor,
adjacent-pair CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, contrast. Do not add hex values
to a page; do not reorder the palette (the order *is* the CVD-safety mechanism).

Four color jobs, one rule each:

- **Categorical (identity):** the 8-slot `colorPalettes.default`, assigned in
  fixed order — blue, orange, aqua, yellow, magenta, green, violet, red. Keep
  series order stable in SQL (`order by`) so entities keep their hue. When a
  chart's series can appear/disappear with a filter, pin identity with
  `seriesColors={{'EMEA':'#2a78d6', …}}` so survivors are never repainted.
- **Sequential (magnitude):** one hue, light→dark — `colorScales.default`
  (blue). Heatmaps and colorscale table columns only. Never a rainbow.
- **Diverging (polarity):** blue ↔ red around a neutral gray midpoint, for
  values with a meaningful zero/center. Never a colored midpoint.
- **Status (state):** `positive` / `warning` / `negative` / `info` theme colors
  are **reserved** — deltas, alerts, conditional table cells. Never used as
  "series 4", and never color alone: pair with an arrow, icon, or label
  (Evidence's `Delta` and `contentType=delta` do this correctly).

Mode-specific caveats:

- **Light-mode relief rule:** slots 3–5 (aqua `#1baf7a`, yellow `#eda100`,
  magenta `#e87ba4`) are below 3:1 contrast on white. Legal, but a chart using
  them must have visible value labels or a companion table.
- **All-pairs limit:** scatter/bubble/maps (where any series can neighbor any
  other) support at most the first **3** slots. Past that, facet or fold.
- Dark mode is *its own stepped palette* in the config, not an automatic flip.
  When editing the theme, re-validate both modes against both surfaces.

Text is never colored by series: values, labels, and legends stay in default
ink; the mark next to them carries identity.

## Marks and chrome

Evidence's defaults are close to correct; enforce the rest:

- **Titles state the takeaway or the question**, not the SQL ("Weekly revenue by
  region", not "revenue_by_week_region"). Subtitles carry units and exclusions.
- **Formats always** (`fmt=`): `usd0k` for revenue at scale, `usd0` for exact,
  `pct1` for shares/growth, `num0` for counts. One format per measure, reused
  on every page.
- **Selective labels, never exhaustive**: `labels=true` on bar charts with ≤ ~8
  bars; never a number printed on every point of a dense line.
- Axes start at zero for bars (Evidence default — don't override); lines may
  zoom but then say so in the subtitle.
- Gridlines/axes stay recessive (theme default). Don't add borders or boxes.

## Interaction

- Evidence charts ship hover tooltips by default — never disable them.
- **Filter row composition:** `DateRange` first, then dimension `Dropdown`s
  (multi-select with `selectAllByDefault=true` for dimensions, single-select
  with an explicit "All" option for hierarchies). Name inputs after the
  dimension (`inputs.region`), not the widget.
- **Every input must have a default that renders a complete page** — a blank
  page behind an unselected filter is a bug.
- Drill pattern: `DataTable … link=<url_column>` where the URL column is built
  in SQL (`'/regions/' || region`), landing on a templated page that reuses the
  same metric queries filtered by `${params.<param>}`.
- Cross-page state: keep filter input names identical across pages so muscle
  memory transfers.

## Anti-patterns — check every page against this list

- **Dual axis** (`y2` with a different unit) — the #1 chart mistake. Split it.
- A pie/donut for anything beyond 2–3 slices → stacked bar or table.
- Spaghetti lines (> 4 series) → fold to "Other", facet, or filter.
- Cycled or invented hues; colors not from the theme.
- A KPI tile with no comparison, no sparkline, no target — decoration.
- Restating a metric's business logic in page SQL (filter drift — the Looker
  problem this project exists to avoid).
- Truncated bar axis to exaggerate differences.
- Rainbow/sequential palette used for categories, or categorical hues used for
  magnitude.
- A number on every data point; legends for a single series.
- Tables of raw floats — unformatted, un-linked, unsearchable.
- A page whose filters silently don't apply to some charts, with no subtitle
  saying so.
- Red/green as the only carrier of good/bad (pair with arrows/labels — CVD).
