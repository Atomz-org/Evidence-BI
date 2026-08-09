---
title: Studio
description: Build a dashboard or a report by clicking, then publish it as code.
# A canvas needs the room; the prose column is for the notes underneath it.
full_width: true
---

Every other page here is a **published** answer, written as source and reviewed.
[Explore](/noodle) is the opposite: one ad-hoc question at a time. This page is
what sits between them — assemble several views on one canvas, filter them
together, and when it is worth keeping, **Publish as code** turns the whole thing
into an Evidence page you can drop into `pages/`.

That last step is the difference from Power BI and Tableau. There, the artifact
is a binary in someone's workspace. Here the artifact is markdown: reviewable,
diffable, deployable, and identical in kind to every other page in this project.

<Studio
    tables={['dbt_semantic.orders', 'dbt_semantic.customers']}
    relationships={[
        {
            from: 'dbt_semantic.orders',
            to: 'dbt_semantic.customers',
            on: [['customer_id', 'customer_id']],
            type: 'left'
        }
    ]}
    fields={{
        'dbt_semantic.customers.region': { name: 'Customer Region' },
        'dbt_semantic.orders.net_line_amount_usd': { name: 'Net Line Amount' },
        'dbt_semantic.orders.line_item_count': { name: 'Line Items', format: 'num0' }
    }}
/>

## How it works

**Auto-build** puts a first draft on the canvas — a figure, a trend, a breakdown
and a table, chosen from the catalog. It is not a substitute for building the
thing you meant; it is the fastest way to find out whether the data supports the
question at all, which is what a blank canvas is bad at.

**Every view is a noodle worksheet.** Press *Edit* on a tile and the full shelf
surface opens over the canvas — the same Show Me, the same level-of-detail
expressions, the same table calculations. There is one place a view is built and
one place it is drawn, so the two cannot disagree about what a specification
means.

**Clicking a mark cross-filters the page.** The view you clicked keeps all its
data with the selection highlighted; every other view filters. That asymmetry is
deliberate: filter the source and the bars you would have to click to change your
mind disappear with it.

**Filters compose, they do not overwrite.** A page filter narrows a view that
already filters itself. That can legitimately empty a view — page says East, view
says West — and an empty view is the honest answer to that combination.

## The part that usually goes wrong

A dashboard mixes views built on different tables. When a filter has no join path
to a view's source, most tools quietly drop it, and you get filtered and
unfiltered numbers sitting side by side looking comparable. Here the view says so,
underneath itself, naming the field it could not be filtered by. It is the same
relationship layer the [Explore](/noodle) page uses: tables are linked logically
and joined only when a view actually reaches across them.

## Dashboard or report

The toggle is not cosmetic.

A **dashboard** is scanned and operated: full width, a twelve-column grid, tiles
side by side. A **report** is circulated and archived: a fixed measure, one
exhibit per row, a basis-of-preparation block, and numbered sections with source
lines when it publishes. Print works from either, and the chrome — toolbar,
filter bar, tile controls — is dropped from the printed page.

## Saving, and what a save contains

**Save** keeps a dashboard in this browser; **Export** writes the same JSON to a
file you can share or commit. Either way what is stored is *specifications, never
results* — reopening re-runs the queries rather than showing yesterday's numbers.
The cross-filter is deliberately not saved: reopening should show the dashboard,
not the last thing somebody clicked on it.

## This is still exploration

Numbers built here carry no metric definition. An ad-hoc `Sum of Order Amount USD`
is not the governed `revenue` metric, which excludes cancelled orders and test
accounts. Publishing a dashboard as code makes it reviewable — it does not make
it governed. If one of these numbers starts to matter, it becomes a dbt metric
first, and the page is rebuilt against it.

See the [Metric Dictionary](/metrics) for what is already defined, the
[Gallery](/gallery) for the component set, and [Explore](/noodle) for one question
at a time.
