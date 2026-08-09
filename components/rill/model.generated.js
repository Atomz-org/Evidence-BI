/**
 * GENERATED — do not edit. Run `npm run rill:model` after changing rill/.
 *
 * The Rill project in rill/ compiled for the browser: read_parquet() paths
 * rewritten to Evidence's registered tables, field selectors resolved, and the
 * additive claims on measures checked. scripts/build-rill-model.mjs is the
 * source of the rules; rill/ is the source of the definitions.
 */

/** @type {import('./engine/metrics.js').RillModel} */
export const RILL = {
	"project": {
		"displayName": "Evidence BI — governed metrics",
		"description": "The dbt semantic mart, expressed as a Rill metrics view so that a measure has one definition whichever surface asks for it.",
		"olapConnector": "duckdb"
	},
	"models": {
		"orders_enriched": {
			"name": "orders_enriched",
			"file": "rill/models/orders_enriched.sql",
			"rillSql": "-- One row per order, with the customer's country attached.\n--\n-- The read_parquet() paths here are load-bearing in two places at once. Rill\n-- resolves them from the project root, where ./data is the Evidence parquet\n-- (rill/up.sh puts it there). scripts/build-rill-model.mjs rewrites each\n--\n--     read_parquet('data/<source>/<table>/<table>.parquet')\n--\n-- to the bare `<source>.<table>` that Evidence has already registered in\n-- duckdb-wasm. One model, two resolvers — so the join grain, the coalesce and\n-- the column list cannot differ between the Rill dashboard and this site.\n--\n-- Keep the pattern literal. A computed path, a glob, or a second parquet in the\n-- same call will not rewrite, and the generator fails loudly rather than\n-- emitting SQL the browser cannot run.\nselect\n    o.order_id,\n    o.customer_id,\n    o.region,\n    o.order_status,\n    o.line_item_count,\n    o.order_amount_usd,\n    o.net_line_amount_usd,\n    o.ordered_at,\n    -- Guest checkouts have no customer row, so country is genuinely unknown\n    -- rather than missing by accident. Naming it keeps it visible in a\n    -- leaderboard instead of silently dropping those orders from one.\n    coalesce(c.country_code, 'unknown') as country_code\nfrom read_parquet('data/dbt_semantic/orders/orders.parquet') o\nleft join read_parquet('data/dbt_semantic/customers/customers.parquet') c\n       on o.customer_id = c.customer_id\n",
			"sql": "-- One row per order, with the customer's country attached.\n--\n-- The read_parquet() paths here are load-bearing in two places at once. Rill\n-- resolves them from the project root, where ./data is the Evidence parquet\n-- (rill/up.sh puts it there). scripts/build-rill-model.mjs rewrites each\n--\n--     read_parquet('data/<source>/<table>/<table>.parquet')\n--\n-- to the bare `<source>.<table>` that Evidence has already registered in\n-- duckdb-wasm. One model, two resolvers — so the join grain, the coalesce and\n-- the column list cannot differ between the Rill dashboard and this site.\n--\n-- Keep the pattern literal. A computed path, a glob, or a second parquet in the\n-- same call will not rewrite, and the generator fails loudly rather than\n-- emitting SQL the browser cannot run.\nselect\n    o.order_id,\n    o.customer_id,\n    o.region,\n    o.order_status,\n    o.line_item_count,\n    o.order_amount_usd,\n    o.net_line_amount_usd,\n    o.ordered_at,\n    -- Guest checkouts have no customer row, so country is genuinely unknown\n    -- rather than missing by accident. Naming it keeps it visible in a\n    -- leaderboard instead of silently dropping those orders from one.\n    coalesce(c.country_code, 'unknown') as country_code\nfrom dbt_semantic.orders o\nleft join dbt_semantic.customers c\n       on o.customer_id = c.customer_id",
			"sources": [
				"dbt_semantic.orders",
				"dbt_semantic.customers"
			]
		}
	},
	"metricsViews": {
		"orders_metrics": {
			"name": "orders_metrics",
			"file": "rill/metrics/orders_metrics.yaml",
			"label": "Orders",
			"description": "One row per order from the dbt semantic mart, with the customer's country joined on. Revenue is gross unless the measure says otherwise.",
			"model": "orders_enriched",
			"timeseries": "ordered_at",
			"smallestTimeGrain": "day",
			"dimensions": [
				{
					"name": "region",
					"label": "Region",
					"description": "Denormalized onto the order via the customer entity. Orders with no customer record are bucketed as \"Guest checkout\" upstream, in sources/dbt_semantic/orders.sql, so the buckets are exhaustive.\n",
					"expression": "\"region\"",
					"isColumn": true,
					"column": "region"
				},
				{
					"name": "order_status",
					"label": "Order status",
					"description": "Lifecycle state at extract time, not at order time.",
					"expression": "\"order_status\"",
					"isColumn": true,
					"column": "order_status"
				},
				{
					"name": "country_code",
					"label": "Country",
					"description": null,
					"expression": "\"country_code\"",
					"isColumn": true,
					"column": "country_code"
				},
				{
					"name": "order_size",
					"label": "Order size",
					"description": "Value bands, so a leaderboard can show mix without a measure.",
					"expression": "case when order_amount_usd >= 500 then 'Large (500+)'\n     when order_amount_usd >= 100 then 'Medium (100-499)'\n     else 'Small (under 100)' end",
					"isColumn": false,
					"column": null
				}
			],
			"measures": [
				{
					"name": "revenue",
					"label": "Revenue",
					"description": "Gross order value in USD. Includes cancelled orders — filter, or use net revenue.",
					"expression": "sum(order_amount_usd)",
					"formatPreset": "currency_usd",
					"formatD3": null,
					"percentOfTotal": true,
					"lowerIsBetter": false
				},
				{
					"name": "net_revenue",
					"label": "Net revenue",
					"description": "Line-level amount after discounts, summed to the order.",
					"expression": "sum(net_line_amount_usd)",
					"formatPreset": "currency_usd",
					"formatD3": null,
					"percentOfTotal": true,
					"lowerIsBetter": false
				},
				{
					"name": "orders",
					"label": "Orders",
					"description": null,
					"expression": "count(*)",
					"formatPreset": "humanize",
					"formatD3": null,
					"percentOfTotal": true,
					"lowerIsBetter": false
				},
				{
					"name": "line_items",
					"label": "Line items",
					"description": null,
					"expression": "sum(line_item_count)",
					"formatPreset": "humanize",
					"formatD3": null,
					"percentOfTotal": true,
					"lowerIsBetter": false
				},
				{
					"name": "customers",
					"label": "Customers",
					"description": "Distinct customers who ordered in the window. Does not add up across slices.",
					"expression": "count(distinct customer_id)",
					"formatPreset": "humanize",
					"formatD3": null,
					"percentOfTotal": false,
					"lowerIsBetter": false
				},
				{
					"name": "avg_order_value",
					"label": "Average order value",
					"description": null,
					"expression": "sum(order_amount_usd) / nullif(count(*), 0)",
					"formatPreset": "currency_usd",
					"formatD3": null,
					"percentOfTotal": false,
					"lowerIsBetter": false
				},
				{
					"name": "cancellation_rate",
					"label": "Cancellation rate",
					"description": "Share of orders in the window whose current status is cancelled.",
					"expression": "count(*) filter (where order_status = 'cancelled') / nullif(count(*)::double, 0)",
					"formatPreset": "percentage",
					"formatD3": null,
					"percentOfTotal": false,
					"lowerIsBetter": true
				}
			]
		}
	},
	"explores": {
		"revenue": {
			"name": "revenue",
			"file": "rill/explores/revenue.yaml",
			"label": "Revenue explore",
			"description": "Where revenue came from in the selected window, and what moved against the window before it.",
			"banner": null,
			"metricsView": "orders_metrics",
			"dimensions": [
				"region",
				"order_status",
				"country_code",
				"order_size"
			],
			"measures": [
				"revenue",
				"net_revenue",
				"orders",
				"line_items",
				"customers",
				"avg_order_value",
				"cancellation_rate"
			],
			"timeRanges": [
				"P7D",
				"P14D",
				"P4W",
				"P3M",
				"inf"
			],
			"defaults": {
				"measures": [
					"revenue",
					"orders",
					"avg_order_value"
				],
				"dimensions": [
					"region",
					"order_status",
					"country_code"
				],
				"timeRange": "P4W",
				"comparisonMode": "time"
			}
		}
	},
	"sourceHash": "403ab0ea675d7efd"
};

export const { project, models, metricsViews, explores, sourceHash } = RILL;

export default RILL;
