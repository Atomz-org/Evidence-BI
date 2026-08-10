---
name: dashboard-loop
description: >
  Use this skill to build a dashboard or report to a world-class standard by
  iterating: draft it, score it mechanically, critique what the score cannot
  see, fix the highest-cost finding, repeat until the loop converges. Use it
  whenever the ask is open-ended about quality — "make this dashboard great",
  "build a world-class view of X", "improve this page", "review this dashboard"
  — or whenever a page has been drafted and needs to be finished properly.
  Triggers: "world-class", "iterate", "improve the dashboard", "review this
  page", "polish", "make it better", "dashboard loop", "audit".
---

# The dashboard loop

A dashboard is never finished by one pass. It is finished when a specific set of
checks stops finding anything and a reader can answer the page's question without
asking a follow-up. This skill is that cycle, made to terminate.

**The reason it terminates** is that most of the quality bar in this project is
already written down and mechanically checkable — the non-negotiables in
`evidence-bi`, the palette in `evidence.config.yaml`, the channel rules in
`flint-chart`. `scripts/dashboard-audit.mjs` checks those, so each pass either
moves the score or it does not. What the score cannot see is judged once per
pass, against a fixed list, not re-litigated freely.

## The cycle

```
0. FRAME     one sentence: who reads this, to decide what
1. DRAFT     build the page against evidence-bi's anatomy
2. SCORE     npm run dashboard:audit -- pages/<page>.md
3. CRITIQUE  the seven questions below, once, in order
4. FIX       the single highest-cost finding, then re-score
5. STOP      when the exit conditions are met
```

Passes 2–4 repeat. Passes are cheap; passes that change nothing are the signal
to stop, not to look harder.

### 0. Frame — one sentence, before any SQL

> *"A regional sales lead opens this weekly to decide which region needs
> attention."*

Write it down. It settles the argument at every later step: which number is the
headline, what the default filter is, whether a chart earns its space, when the
page is done. A page without this sentence cannot be finished because nothing
distinguishes a good addition from any other addition.

If the ask does not supply the reader and the decision, ask — this is the one
question worth blocking on.

### 1. Draft

Build to the anatomy in `.claude/skills/evidence-bi` § Page anatomy: title +
context sentence → one filter row → KPI row → primary trend → breakdowns →
detail table with drill links. Start from metrics in `queries/metrics/`, never
from ad-hoc business logic.

Charts: `.claude/skills/flint-chart` for `<FlintChart>`, or Evidence's own
components where the form is already decided. Both draw from the same palette.

**Draft the whole page before improving any part of it.** A loop that polishes
the first chart before the last one exists optimises the wrong thing.

### 2. Score

```bash
npm run dashboard:audit -- pages/<page>.md      # one page
npm run dashboard:audit                          # every page
npm run dashboard:audit -- --json                # for diffing between passes
```

Errors are violations of a non-negotiable; warnings cost score but do not block.
The score is `100 − 3×errors − warnings`, and its only job is to be comparable
between passes.

Rules and what they mean: `references/rubric.md`.

A page may opt out of a rule it genuinely does not apply to:

```markdown
<!-- audit-ignore: kpi-needs-comparison -->
```

Use this for demonstration pages, not to make a finding go away. It names rules
individually and there is no "all" — if you are reaching for a second ignore on
one page, the page is probably wrong.

### 3. Critique — what the audit cannot see

Ask these seven, in order, once per pass. Answer them about **this** page, not in
general. Stop at the first one that fails — fixing it usually changes the answers
below it.

1. **Does the top of the page answer the framing question?** Not "does it show
   relevant data" — does a reader who scrolls no further have the answer? If the
   headline number is not the one in the framing sentence, nothing else matters.
2. **Is every number comparable to something?** A figure with no prior period,
   target or trend is a decoration. The audit checks `BigValue`; check the charts
   too — an absolute-level line with no reference line is the same failure.
3. **Can a reader tell what is excluded?** Cancelled orders, test accounts, guest
   checkouts, the date window. If the basis is not on the page, the number is not
   usable, and a wrong decision made from it is the page's fault.
4. **Does each chart earn its space?** Name the question it answers. Two charts
   answering the same question is one chart too many; a chart nobody asked a
   question of is decoration.
5. **Is the form right for the job?** Change over time, magnitude, composition,
   distribution, correlation, lookup — the job picks the form, and often the
   answer is a `BigValue` or a `DataTable`.
   → `evidence-bi/references/design-principles.md` § Choosing a form
6. **Does it hold up in dark mode, at 1280px, and in print?** The palette is
   validated for both surfaces, but layout is not. A KPI row that wraps to two
   lines on a laptop is a different page from the one you built.
7. **Can the reader get from a number to its rows?** A drill link or a table.
   Every claim inspectable, or it is a claim.

Then one last question, which is not on the list because it is asked differently:
**what would the reader ask next?** If the page cannot answer it and it is the
obvious next question, that is the next thing to build — not a polish item.

### 4. Fix one thing

Fix the **highest-cost** finding, not the easiest. Cost order:

1. A wrong number — bad grain, restated business logic, a metric that is not one
2. A missing comparison — the number is right and still unusable
3. A missing basis — the reader cannot know what is excluded
4. The wrong form — the data is right and unreadable
5. Colour, format, spacing, labels

Then re-score. One fix per pass keeps the score attributable; batching four
changes and watching the score move tells you nothing about which one did it.

### 5. Stop

Stop when **all** of these hold:

- `npm run dashboard:audit` reports **zero errors** on the page
- The seven critique questions all pass
- `npm run build` succeeds — a broken query is a broken page
- The last pass changed nothing material

And stop anyway when two consecutive passes produce only cosmetic changes. Past
that point the loop is generating work, not quality. Say so and hand it back.

## Anti-patterns of the loop itself

- **Polishing before the page is drafted.** The last chart changes what the first
  one should be.
- **Fixing warnings while errors stand.** A pretty page with a wrong number is
  worse than a plain one, because it is believed.
- **Re-critiquing freely each pass.** Seven fixed questions, in order. An
  open-ended critique always finds something and never converges.
- **Adding a chart because there is space.** Space is not a finding.
- **Suppressing a rule instead of fixing it.** `audit-ignore` is for pages the
  rule does not apply to. There is a difference and it is usually obvious.
- **Declaring done without running the build.** The audit reads source; only the
  build runs the SQL.

## Reference files

| File | What it answers |
|------|-----------------|
| `references/rubric.md` | Every audit rule: what it checks, why, and how to fix it |
| `references/worked-example.md` | One page taken from 54/100 to clean, pass by pass |

## Related

- `.claude/skills/evidence-bi` — the standard being enforced. The audit is
  downstream of it; when the two disagree, that skill wins and the rule is wrong.
- `.claude/skills/flint-chart` — chart authoring, and the per-chart audit
  (`showAudit=true`) that runs in the page while you build.
