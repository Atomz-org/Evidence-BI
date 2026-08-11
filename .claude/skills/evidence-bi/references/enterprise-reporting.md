# Enterprise reporting standard

A dashboard and a report are different deliverables. A dashboard is *scanned* and
operated; a report is *circulated, cited, and archived* — someone will quote a figure
from it in a meeting six weeks from now, and the report has to survive that.

Use this file when the ask is a **report** (management pack, board pack, MI, a page
someone will export to PDF). For an operational dashboard, `design-principles.md`
governs. The two share the palette and the metric contract; they differ in chrome,
number formats, and what has to be stated on the page.

## What a report carries that a dashboard doesn't

| Element | Why it exists |
|---|---|
| **Control block** | report ID + version, reporting period, data as-of, owner, currency, classification. A figure with no as-of date is unciteable. |
| **Applied filters, stated** | the reader must know what was excluded. A filtered figure that doesn't say so is a wrong figure. |
| **Basis of preparation** | scope, exclusions, treatment of edge cases, comparative method, materiality. This is the section Finance reads first. |
| **Numbered exhibits + source line** | every visual names the compiled query behind it, so a figure can be traced without asking the author. |
| **Metric register** | every measure used, its rule, and the file it compiles from. |
| **Data lineage** | source system → mart → metric → compiled query → page. |
| **Footnotes** | caveats attach to the figure they qualify, not to a paragraph elsewhere. |

In this project the basis of preparation is not prose someone maintains by hand — it is
a restatement of the dbt metric definitions. If the YAML and the report disagree, the
report is wrong.

## Number conventions

Registered once in `.evidence/customization/custom-formatting.json` and referenced by
tag, never re-typed as a format string in a page:

| Tag | Renders | Use for |
|---|---|---|
| `usdacc` | `$165,082` / `($431)` | currency in tables and KPIs |
| `usdacc2` | `$589.58` / `($0.43)` | unit values (AOV, price) |
| `usdacck` | `$165.1k` / `($42.0k)` | chart axes and labels |
| `numacc` | `280` / `(90)` | counts |
| `pctacc` | `47.3%` / `(0.1%)` | shares and variances |
| `rptdate` | `04 Aug 2026` | any date on a report |
| `rptmonth` | `Aug 2026` | month grain |

Evidence formats via SSF (Excel codes), so the `positive;negative` section syntax works —
that is what puts adverse values in parentheses. To add a format, add it to that JSON
file; do not inline a new code into a page. A format code carries no colour: never add a
`[Red]` tag to one. Colour is the renderer's job — `redNegatives` on `<Column>`,
`<Value>`, or a DataTable column — and it is opt-in per component, not a project default.

Rules that go with them:

- **Adverse in parentheses.** Never a bare minus sign in a report table. Add
  `redNegatives` to the component as well when the page wants red as well as brackets.
- **Units in the header or subtitle**, never repeated per cell.
- **One decimal on percentages**, two on unit currency, none on aggregate currency.
- **Averages re-divide at every grain** — `sum(numerator) / sum(denominator)`. Averaging
  an average is the single most common reporting error. Use
  `totalAgg=weightedMean weightCol=<denominator>` on any average column.
- **Totals must foot.** A total row that doesn't equal the sum of the rows above is a
  defect, not a rounding quirk.

## Comparatives

- **Query the prior period; never derive it from the growth rate.** Back-computing
  `prior = current / (1 + growth)` reintroduces rounding and the table stops footing.
- State the comparative method on the page: here, the prior window is the selected range
  shifted back by its own length.
- **`All Time` blanks every comparison** — there is no earlier window of equal length.
  That is correct behaviour, and the page should say so rather than look broken.

## Materiality

A percentage on a tiny base is noise wearing a suit. A country with three orders can post
+189% and mean nothing.

- Set a threshold, apply it **in SQL**, and state it in the basis of preparation:

  ```sql
  case when order_count >= 10
       then (current - prior) / nullif(prior, 0)
  end as revenue_variance
  ```

- Suppressed cells render blank (or `nm`), never `0%` and never the raw number.
- Commentary obeys the same threshold, and excludes buckets that aren't the thing being
  compared — the guest-checkout bucket is not a country.

## Print and export

Reports get exported. Build for it:

- `<PageBreak/>` between top-level sections.
- `<PrintGroup>` around an exhibit so a chart and its caption never split across a page.
- Inputs carry `hideDuringPrint` by default — a slicer in a PDF is noise.
- `<LastRefreshed/>` in the control block so the printed copy carries its own as-of.

## Evidence gotcha: fenced code blocks become queries

**A fenced code block at the top level of an Evidence page is extracted as a query, and
the info string becomes the query id** — regardless of the language tag and regardless of
whether you used three or four backticks. ` ```text ` registers a query named `text`,
which then fails to parse and renders an error box on the page.

To show code that must not run, either:

- **indent it four spaces** (no info string, nothing to extract) — simplest and safest; or
- **nest the fence inside an HTML element** (`<Details>`, `<AccordionItem>`), which is
  what the feature tour does for its dbt YAML and SQL samples.

`npm run build` catches this — the page's `evidencemeta.json` lists every registered
query, so a stray id there is the tell:

```bash
python3 -c "import json;print([q['id'] for q in json.load(open('build/api/<route>/evidencemeta.json'))['queries']])"
```

## Report page skeleton

```
frontmatter: title, description, queries
control query  → period_start, period_end, data_as_of
<Details title="Report control">  metadata table
filter row (DateRange defaulting to a bounded preset, Dropdown, ButtonGroup)

## 1 · Executive summary        KPI row + movement table + alert on method
## 2 · Trend and mix            exhibits with source lines, then the table
## 3 · Composition              exhibits + a caveat Alert where one is owed
## 4 · Detail                   grouped table, subtotals, weighted averages, drill link
## 5 · Basis of preparation     scope, exclusions, comparatives, materiality,
                                metric register, lineage, presentation standards
```

Worked example: `pages/reports/revenue-performance.md`.

## What not to do

- Don't restate a business rule in a report page. If the number needs a new rule, the fix
  is a dbt PR — the same contract as every other page in this project.
- Don't put a KPI on a report without a comparative or a stated reason it has none.
- Don't let a chart carry a figure that appears nowhere in a table.
- Don't invent an entity name, logo, or byline for a report. Label the owner and the data
  for what they actually are; a report that looks like it came from a real organisation
  it didn't come from is a forgery, not a template.
