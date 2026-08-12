# Semantic types — the 44 registered names

Generated from `SemanticTypes` in `flint-chart@0.5.0`. Regenerate after an
upgrade:

```bash
node --input-type=module -e "
import { SemanticTypes, getVisCategory, getZeroClass } from 'flint-chart';
for (const t of Object.values(SemanticTypes))
  console.log([t, getVisCategory(t), getZeroClass(t)].join(' | '));
"
```

A name not on this list is **ignored** — Flint falls back to sniffing raw values,
and the audit warns. Spelling is exact and case-sensitive.

## What a type decides

| Column | Meaning |
|--------|---------|
| **category** | The encoding type Flint resolves: quantitative, ordinal, nominal, temporal |
| **zero** | Whether zero is a real baseline. `meaningful` → the axis starts at zero and ratios are legitimate. `arbitrary` → the axis is free to start anywhere (a temperature axis starting at 0 wastes the plot). `contextual` → depends on the chart. `unknown` → Flint decides from the data |

Zero-baseline handling is the single biggest reason to type a measure correctly.
`Amount` starts the axis at zero because a bar half as tall must mean half as
much money. `Temperature` does not, because 20°C is not twice 10°C.

## Measures

| Type | category | zero | Use for |
|------|----------|------|---------|
| `Amount` | quantitative | meaningful | Money. **The default for revenue, cost, spend, AOV in this project** |
| `Price` | quantitative | meaningful | A unit price rather than a total |
| `Profit` | quantitative | meaningful | A signed money figure — margin, contribution, P&L |
| `Count` | quantitative | meaningful | Whole things counted: orders, customers, tickets |
| `Quantity` | quantitative | meaningful | A measured amount that is not money and not a count |
| `Duration` | quantitative | meaningful | Elapsed time as a measure — lead time, session length |
| `Percentage` | quantitative | contextual | A share, 0–100 or 0–1. Bounded domain |
| `PercentageChange` | quantitative | contextual | A delta. Diverges around zero, so it gets the diverging treatment |
| `Correlation` | quantitative | meaningful | −1 to 1, diverging around zero |
| `Sentiment` | quantitative | meaningful | Signed opinion score, diverging around zero |
| `Temperature` | quantitative | arbitrary | Temperature. Zero is a convention, not an absence |
| `Number` | quantitative | meaningful | The generic escape hatch. Prefer a specific type |

For this project's metrics: `revenue` → `Amount`, `order_count` → `Count`,
`average_order_value` → `Amount`, `emea_revenue_share` → `Percentage`,
`revenue_growth_mom` → `PercentageChange`.

## Time

| Type | category | zero | Use for |
|------|----------|------|---------|
| `Date` | temporal | — | A calendar date. **The default for `metric_time` and `week`** |
| `DateTime` | temporal | — | Date plus time of day |
| `Timestamp` | temporal | — | A precise instant |
| `Time` | temporal | — | Time of day with no date |
| `Year` | temporal | arbitrary | A year as a point on a timeline |
| `YearMonth` | temporal | — | `2026-08` — a month with its year, sortable |
| `YearQuarter` | temporal | — | `2026-Q3` |
| `YearWeek` | temporal | — | `2026-W32` |
| `Decade` | temporal | arbitrary | Ten-year buckets |
| `Month` | ordinal | — | Month **of the year**, cyclic — Jan…Dec across years |
| `Quarter` | ordinal | — | Q1…Q4, cyclic |
| `Week` | ordinal | — | Week of the year, cyclic |
| `Day` | ordinal | — | Day of the week or month, cyclic |
| `Hour` | ordinal | arbitrary | Hour of the day, cyclic |

**`Month` vs `YearMonth` is the trap.** `Month` is cyclic — twelve buckets that
repeat, right for a seasonality chart. `YearMonth` is a timeline that never
repeats, right for a trend. Using `Month` on a multi-year trend silently folds
every year on top of each other.

## Place

| Type | category | Use for |
|------|----------|---------|
| `Region` | nominal | **This project's `region` column** |
| `Country` | nominal | Country names or codes |
| `State` | nominal | First-level subdivision |
| `City` | nominal | City names |
| `Address` | nominal | A full address string |
| `ZipCode` | nominal | Postal codes — not a number, however numeric it looks |
| `Latitude` | quantitative | Degrees north |
| `Longitude` | quantitative | Degrees east |

## Categories and ordering

| Type | category | Use for |
|------|----------|---------|
| `Category` | nominal | The general categorical. Unordered, one hue per value |
| `Status` | nominal | A state machine's values — `order_status`, lifecycle stages |
| `Name` | nominal | A proper name: customer, product, employee |
| `Boolean` | nominal | Two values |
| `Direction` | ordinal | Ordered direction — up/flat/down, in/out |
| `Range` | ordinal | Ordered buckets — `0-10`, `10-50`, `50+`. Keeps bucket order |
| `Rank` | ordinal | A position in an order. Lower is better, so scales invert |
| `Score` | quantitative | A bounded rating — NPS, 1–5 stars, a health score |
| `ID` | nominal | An identifier. Marks it as **not** a measure, however numeric |
| `Unknown` | nominal | Explicitly unclassified. Prefer leaving the column out of `types` |

**Type your IDs.** An `order_id` or `customer_id` left untyped is sniffed as a
number and Flint will happily average it. `ID` stops that.

## Picking one

1. **Is it money?** `Amount` — or `Price` for a unit price, `Profit` if it can go
   negative.
2. **Is it counted?** `Count`.
3. **Is it a share or a delta?** `Percentage` or `PercentageChange`. These get
   bounded domains and diverging treatment; a raw `Number` gets neither.
4. **Is it time?** A point on a timeline → `Date`/`YearMonth`/`YearQuarter`. A
   repeating bucket → `Month`/`Quarter`/`Day`/`Hour`.
5. **Is it a place?** Use the place type — it opens geographic handling later.
6. **Does it have an inherent order?** `Range`, `Direction`, `Rank`, `Score` keep
   their order. `Category` does not, and will be sorted by value.
7. **Otherwise** `Category` for a label, `ID` for a key.

When genuinely unsure, leave the column out of `types` rather than guessing —
Flint's inference from raw values beats a wrong type, because a wrong type
propagates confidently into scale, sort order and zero baseline.

## Annotations

A type may be given as an object rather than a string when the column needs more
than a name. The object is Flint's `SemanticAnnotation`, and it has exactly five
fields:

| Field | Type | For |
|-------|------|-----|
| `semanticType` | string | The type name. Required — this is the only mandatory field |
| `intrinsicDomain` | `[min, max]` | A bounded scale: `[1, 5]` for stars, `[0, 100]` for a score. Not for open-ended measures |
| `unit` | string | `"USD"`, `"°C"`, `"kg"` |
| `divergingMidpoint` | number | What the reader is comparing against. Declaring it *asserts* the split — the scale diverges even if every value lands on one side |
| `sortOrder` | `string[]` | Explicit ordinal order: `["Low", "Medium", "High"]` |

```svelte
types={{
    health_score: { semanticType: 'Score', intrinsicDomain: [0, 100] },
    margin_pct:   { semanticType: 'Percentage', divergingMidpoint: 0, unit: '%' },
    tier:         { semanticType: 'Range', sortOrder: ['Small', 'Medium', 'Large'] }
}}
```

`divergingMidpoint` is a judgement about the question, not a fact about the
column — a temperature pivots at 0 if the question is whether it freezes and near
18 if the question is whether a city is comfortable. Declare it when the chart is
about the comparison; leave it out otherwise.

Keep annotations rare. If a column seems to need one, first check that the plain
type is not simply wrong. Note the field is `semanticType`, not `type` — a
mis-spelled key is ignored silently.
