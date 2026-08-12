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
					"description": "Value bands, so a leaderboard can show mix without a measure. Small is under $100, Medium $100-499, Large $500 and up. The thresholds live in the description rather than in the labels: a band name is an axis tick before it is documentation, and \"Small (under 100)\" clipped on a heatmap axis tells the reader neither.\n",
					"expression": "case when order_amount_usd >= 500 then 'Large'\n     when order_amount_usd >= 100 then 'Medium'\n     else 'Small' end",
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
	"canvases": {
		"executive": {
			"name": "executive",
			"file": "canvas/executive.yaml",
			"label": "One Dashboard",
			"description": "Where revenue came from in the selected window, what moved against the window before it, and the room to ask why.",
			"metricsView": "orders_metrics",
			"timeRanges": [
				"P7D",
				"P14D",
				"P4W",
				"P3M",
				"inf"
			],
			"defaults": {
				"timeRange": "P4W",
				"comparisonMode": "time",
				"filters": {}
			},
			"gapX": 12,
			"gapY": 12,
			"rows": [
				{
					"height": 112,
					"items": [
						{
							"component": "kpi_grid",
							"extension": false,
							"width": 12,
							"height": 112,
							"flintTemplate": null,
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"measures": [
									"revenue",
									"orders",
									"avg_order_value",
									"cancellation_rate"
								],
								"comparison": true
							}
						}
					]
				},
				{
					"height": 360,
					"items": [
						{
							"component": "line_chart",
							"extension": false,
							"width": 7,
							"height": 360,
							"flintTemplate": "Line Chart",
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"measure": "revenue",
								"series": "region",
								"grain": "day",
								"title": "Revenue by region",
								"subtitle": "Daily. The dashed comparison lives on the KPI row, not here"
							}
						},
						{
							"component": "bar_chart",
							"extension": false,
							"width": 5,
							"height": 360,
							"flintTemplate": "Bar Chart",
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"measure": "revenue",
								"dimension": "order_status",
								"orientation": "horizontal",
								"title": "Where revenue sits",
								"subtitle": "By current order status"
							}
						}
					]
				},
				{
					"height": 290,
					"items": [
						{
							"component": "x_leaderboard",
							"extension": true,
							"width": 6,
							"height": 290,
							"flintTemplate": null,
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"dimension": "region",
								"measure": "revenue"
							}
						},
						{
							"component": "x_leaderboard",
							"extension": true,
							"width": 6,
							"height": 290,
							"flintTemplate": null,
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"dimension": "country_code",
								"measure": "revenue"
							}
						}
					]
				},
				{
					"height": 400,
					"items": [
						{
							"component": "x_pivot",
							"extension": true,
							"width": 12,
							"height": 400,
							"flintTemplate": null,
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"rows": [
									"region"
								],
								"columns": [
									"order_status"
								],
								"measures": [
									"revenue",
									"avg_order_value"
								],
								"title": "Revenue and AOV, region x status",
								"totals": true
							}
						}
					]
				},
				{
					"height": 360,
					"items": [
						{
							"component": "heatmap",
							"extension": false,
							"width": 6,
							"height": 360,
							"flintTemplate": "Heatmap",
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"measure": "revenue",
								"dimension": "order_size",
								"y": "order_status",
								"title": "Revenue by value band and status",
								"subtitle": "Colour is revenue; an empty cell is a combination with no orders"
							}
						},
						{
							"component": "table",
							"extension": false,
							"width": 6,
							"height": 360,
							"flintTemplate": null,
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"dimensions": [
									"country_code"
								],
								"measures": [
									"revenue",
									"orders",
									"avg_order_value"
								],
								"title": "Countries in the window",
								"limit": 8
							}
						}
					]
				},
				{
					"height": null,
					"items": [
						{
							"component": "x_notebook",
							"extension": true,
							"width": 12,
							"height": null,
							"flintTemplate": null,
							"types": {
								"revenue": "Amount",
								"net_revenue": "Amount",
								"orders": "Count",
								"line_items": "Count",
								"customers": "Count",
								"avg_order_value": "Amount",
								"cancellation_rate": "Percentage",
								"region": "Region",
								"order_status": "Status",
								"country_code": "Country",
								"order_size": "Category",
								"bucket": "Date"
							},
							"config": {
								"title": "Ask something else",
								"markdown": "Every tile above is compiled from the metrics view and cannot be edited — that is what makes `revenue` mean one thing on this page. This cell is the opposite: it starts from the board's current window and filters, and then it is yours. Nothing you do here changes a number above it.\n",
								"sql": "-- Orders per customer in the selected window: a shape question the\n-- metrics view has no measure for, which is exactly when to drop\n-- down to SQL rather than add one.\nselect orders_placed,\n       count(*) as customers,\n       sum(revenue) as revenue\nfrom (\n    select customer_id,\n           count(*) as orders_placed,\n           sum(order_amount_usd) as revenue\n    from {{scan}}\n    group by 1\n)\ngroup by 1\norder by 1\n"
							}
						}
					]
				}
			]
		}
	},
	"sourceHash": "db3c40d1f2f285d5"
};

export const { project, models, metricsViews, explores, canvases, sourceHash } = RILL;

export default RILL;
