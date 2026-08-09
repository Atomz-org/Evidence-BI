-- One row per order, with the customer's country attached.
--
-- The read_parquet() paths here are load-bearing in two places at once. Rill
-- resolves them from the project root, where ./data is the Evidence parquet
-- (rill/up.sh puts it there). scripts/build-rill-model.mjs rewrites each
--
--     read_parquet('data/<source>/<table>/<table>.parquet')
--
-- to the bare `<source>.<table>` that Evidence has already registered in
-- duckdb-wasm. One model, two resolvers — so the join grain, the coalesce and
-- the column list cannot differ between the Rill dashboard and this site.
--
-- Keep the pattern literal. A computed path, a glob, or a second parquet in the
-- same call will not rewrite, and the generator fails loudly rather than
-- emitting SQL the browser cannot run.
select
    o.order_id,
    o.customer_id,
    o.region,
    o.order_status,
    o.line_item_count,
    o.order_amount_usd,
    o.net_line_amount_usd,
    o.ordered_at,
    -- Guest checkouts have no customer row, so country is genuinely unknown
    -- rather than missing by accident. Naming it keeps it visible in a
    -- leaderboard instead of silently dropping those orders from one.
    coalesce(c.country_code, 'unknown') as country_code
from read_parquet('data/dbt_semantic/orders/orders.parquet') o
left join read_parquet('data/dbt_semantic/customers/customers.parquet') c
       on o.customer_id = c.customer_id
