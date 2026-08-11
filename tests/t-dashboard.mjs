/**
 * The dashboard model, and the page it publishes.
 *
 * Two things here are worth more than the rest. The first is that a cross-filter
 * must not reach the tile that raised it, and must be *reported* rather than
 * silently dropped when it cannot reach a tile at all — a dashboard showing
 * filtered and unfiltered numbers side by side with no marking is the failure
 * mode that makes people distrust the whole page.
 *
 * The second is the published SQL. `dashboardToMarkdown` templates a filter into
 * an Evidence input by compiling a sentinel literal and swapping it afterwards.
 * Checking the string looks right proves nothing; so the test substitutes a real
 * value into the published query, runs it against the project's parquet, and
 * compares it to the same query with the filter compiled in directly.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { boot } from './duck.mjs';

const ENGINE = `${ROOT}/components/noodle/engine`;
const { buildCatalog } = await import(`${ENGINE}/catalog.js`);
const { compile } = await import(`${ENGINE}/compile.js`);
const { emptySpec, dropField, allPills, __resetPillCounter } = await import(`${ENGINE}/spec.js`);
const D = await import(`${ENGINE}/dashboard.js`);

const { run } = await boot();
__resetPillCounter();
D.__resetTileCounter();

const catalog = await buildCatalog(run, {
	tables: ['dbt_semantic.orders', 'dbt_semantic.customers'],
	relationships: [
		{
			from: 'dbt_semantic.orders',
			to: 'dbt_semantic.customers',
			on: [['customer_id', 'customer_id']],
			type: 'left'
		}
	]
});

const F = (id) => {
	const f = catalog.byId[id];
	if (!f) throw new Error(`no field ${id}`);
	return f;
};

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const ORDERED = 'dbt_semantic.orders.ordered_date';
const AMOUNT = 'dbt_semantic.orders.order_amount_usd';
const STATUS = 'dbt_semantic.orders.order_status';
const REGION = 'dbt_semantic.customers.region';

/** A trend of revenue by month, off the orders table alone. */
const trendSpec = () => {
	let spec = emptySpec('dbt_semantic.orders');
	spec = dropField(spec, catalog, F(ORDERED), 'columns');
	spec = dropField(spec, catalog, F(AMOUNT), 'rows');
	return { ...spec, mark: 'line' };
};

/** Revenue by status — the tile a cross-filter is usually raised from. */
const statusSpec = () => {
	let spec = emptySpec('dbt_semantic.orders');
	spec = dropField(spec, catalog, F(STATUS), 'columns');
	spec = dropField(spec, catalog, F(AMOUNT), 'rows');
	return { ...spec, mark: 'bar' };
};

/* ------------------------------------------------------------ the model -- */

let dash = D.emptyDashboard({ title: 'Test dashboard' });
const trend = D.makeTile({ spec: trendSpec(), title: 'Over time', w: 8, h: 260 });
const byStatus = D.makeTile({ spec: statusSpec(), title: 'By status', w: 4, h: 260 });
dash = D.addTile(D.addTile(dash, trend), byStatus);

check('tiles are added in order', dash.tiles.map((t) => t.title).join(',') === 'Over time,By status');

// --- page filters -----------------------------------------------------------
let filtered = D.addPageFilter(dash, {
	fieldId: STATUS,
	role: 'dimension',
	op: 'in',
	values: ['paid']
});
const trendContext = D.tileContext(filtered, trend, catalog);
check(
	'a page filter reaches every tile',
	trendContext.applied.length === 1 && trendContext.spec.filters.length === 1,
	`${trendContext.applied.length} applied`
);

// A slicer is one control: re-selecting replaces rather than intersects.
filtered = D.addPageFilter(filtered, {
	fieldId: STATUS,
	role: 'dimension',
	op: 'in',
	values: ['fulfilled']
});
check(
	'reselecting a slicer replaces its selection',
	filtered.filters.length === 1 && filtered.filters[0].values[0] === 'fulfilled',
	JSON.stringify(filtered.filters)
);

// --- cross-filtering --------------------------------------------------------
const crossed = D.toggleCrossFilter(dash, {
	tileId: byStatus.id,
	fieldId: STATUS,
	values: ['paid'],
	label: 'Status: paid'
});
check(
	'a cross-filter does not filter the tile that raised it',
	D.tileContext(crossed, byStatus, catalog).spec.filters.length === 0
);
check(
	'a cross-filter does filter the other tiles',
	D.tileContext(crossed, trend, catalog).spec.filters.length === 1
);
check(
	'clicking the same value again clears it',
	D.toggleCrossFilter(crossed, {
		tileId: byStatus.id,
		fieldId: STATUS,
		values: ['paid'],
		label: 'Status: paid'
	}).crossFilter === null
);
check(
	'deleting the source tile clears its cross-filter',
	D.removeTile(crossed, byStatus.id).crossFilter === null
);

// --- reachability -----------------------------------------------------------
// An orders-only tile can reach a customer attribute through the declared
// relationship, so this filter applies rather than being reported.
check(
	'a filter reaches across a declared relationship',
	D.filterReaches(catalog, trendSpec(), REGION)
);

const islandCatalog = { ...catalog, relationships: [] };
check(
	'a filter with no join path is reported, not applied',
	(() => {
		const context = D.tileContext(
			D.addPageFilter(dash, { fieldId: REGION, role: 'dimension', op: 'in', values: ['East'] }),
			trend,
			islandCatalog
		);
		return context.ignored.length === 1 && context.applied.length === 0;
	})()
);

// --- merging ----------------------------------------------------------------
check(
	'identical filters are collapsed',
	D.mergeFilters(
		[{ fieldId: STATUS, op: 'in', values: ['a'] }],
		[{ fieldId: STATUS, op: 'in', values: ['a'] }]
	).length === 1
);
check(
	'different selections on one field both survive, and intersect',
	D.mergeFilters(
		[{ fieldId: STATUS, op: 'in', values: ['a'] }],
		[{ fieldId: STATUS, op: 'in', values: ['b'] }]
	).length === 2
);

// --- layout -----------------------------------------------------------------
const packed = D.layoutRows([
	{ id: 'a', w: 8 },
	{ id: 'b', w: 4 },
	{ id: 'c', w: 6 },
	{ id: 'd', w: 12 }
]);
check(
	'tiles pack into twelve columns and wrap',
	packed.length === 3 && packed[0].length === 2 && packed[1].length === 1 && packed[2].length === 1,
	packed.map((r) => r.map((t) => t.w).join('+')).join(' | ')
);

/* ----------------------------------------------------------- persistence -- */

const roundTripped = D.deserializeDashboard(D.serializeDashboard(filtered));
check(
	'a saved dashboard reopens with its tiles and filters',
	roundTripped.tiles.length === 2 &&
		roundTripped.filters.length === 1 &&
		roundTripped.tiles[0].spec.columns.length === 1,
	`${roundTripped.tiles.length} tiles`
);
check(
	'the cross-filter is not saved',
	D.deserializeDashboard(D.serializeDashboard(crossed)).crossFilter === null
);
check(
	'a saved dashboard still compiles to the same SQL',
	compile(catalog, roundTripped.tiles[0].spec).sql === compile(catalog, trendSpec()).sql
);

// Pill keys come from a counter that restarts with the page. Reopening a saved
// dashboard must not hand two different pills the same key, or removing one
// removes both.
const importedKeys = roundTripped.tiles.flatMap((t) => allPills(t.spec).map((p) => p.key));
const freshKeys = allPills(trendSpec()).map((p) => p.key);
check(
	'imported pill keys cannot collide with newly created ones',
	new Set(importedKeys).size === importedKeys.length &&
		!importedKeys.some((k) => freshKeys.includes(k)),
	`${importedKeys.length} imported, ${new Set(importedKeys).size} distinct`
);

const duplicated = D.duplicateTile(dash, trend.id);
check(
	'a duplicated tile shares no pill keys with its original',
	(() => {
		const a = allPills(duplicated.tiles[0].spec).map((p) => p.key);
		const b = allPills(duplicated.tiles[1].spec).map((p) => p.key);
		return duplicated.tiles.length === 3 && !a.some((k) => b.includes(k));
	})()
);

check(
	'a file from a future version is refused rather than half-read',
	(() => {
		try {
			D.deserializeDashboard(JSON.stringify({ version: 99, tiles: [] }));
			return false;
		} catch (e) {
			return /version/i.test(e.message);
		}
	})()
);

/* ------------------------------------------------------------- published -- */

const forPublish = D.addPageFilter(dash, {
	fieldId: STATUS,
	role: 'dimension',
	op: 'in',
	values: ['paid', 'fulfilled']
});
const markdown = D.dashboardToMarkdown({ catalog, dashboard: forPublish, generatedOn: '2026-08-08' });

check('the published page has frontmatter', markdown.startsWith('---\ntitle: Test dashboard'));
check(
	'a page filter becomes an Evidence input',
	/<Dropdown name=order_status_0 data={order_status_0_options}/.test(markdown) && /multiple=true/.test(markdown),
	markdown.match(/<Dropdown[^>]*>/)?.[0] ?? 'no Dropdown'
);
check(
	'the sentinel does not survive into the published page',
	!markdown.includes('__evidence_input_'),
	markdown.includes('__evidence_input_') ? 'sentinel leaked' : ''
);
check(
	'both tiles are published',
	/```sql over_time_1/.test(markdown) && /```sql by_status_2/.test(markdown),
	(markdown.match(/```sql \w+/g) ?? []).join(', ')
);
check('two tiles in one row publish as a Grid', /<Grid cols=2>/.test(markdown));

// The real check: run the published query with a value substituted, and compare
// it to the same view compiled with that filter baked in.
const publishedSql = markdown.match(/```sql over_time_1\n([\s\S]*?)\n```/)?.[1] ?? '';
check('the published query was captured', publishedSql.length > 0);

const substituted = publishedSql.replace(/\$\{inputs\.order_status_0\.value\}/g, `'paid','fulfilled'`);
const control = compile(catalog, {
	...trendSpec(),
	filters: [{ fieldId: STATUS, role: 'dimension', op: 'in', values: ['paid', 'fulfilled'] }]
}).sql;

let publishedRows = [];
let controlRows = [];
try {
	publishedRows = await run(substituted);
	controlRows = await run(control);
} catch (e) {
	check('the published query runs', false, `${e.message}\n${substituted}`);
}

check(
	'the published query runs and agrees with the compiled control',
	publishedRows.length > 0 &&
		publishedRows.length === controlRows.length &&
		JSON.stringify(publishedRows) === JSON.stringify(controlRows),
	`${publishedRows.length} rows published vs ${controlRows.length} control`
);

// A single-value selection templates as a bare `= '${inputs...}'`, which is a
// different substitution and a different Dropdown.
const single = D.addPageFilter(dash, {
	fieldId: STATUS,
	role: 'dimension',
	op: 'eq',
	values: ['paid']
});
const singleMd = D.dashboardToMarkdown({ catalog, dashboard: single, generatedOn: '2026-08-08' });
const singleSql = singleMd.match(/```sql over_time_1\n([\s\S]*?)\n```/)?.[1] ?? '';
check(
	'a single-value filter keeps its quotes around the input',
	singleSql.includes(`= '\${inputs.order_status_0.value}'`) && !singleMd.includes('multiple=true'),
	singleSql.split('\n').find((l) => l.includes('inputs.')) ?? 'no input in SQL'
);

let singleRows = [];
try {
	singleRows = await run(singleSql.replace(/\$\{inputs\.order_status_0\.value}/g, 'paid'));
} catch (e) {
	check('the single-value published query runs', false, `${e.message}\n${singleSql}`);
}
const singleControl = await run(
	compile(catalog, {
		...trendSpec(),
		filters: [{ fieldId: STATUS, role: 'dimension', op: 'eq', values: ['paid'] }]
	}).sql
);
check(
	'the single-value published query agrees with its control',
	singleRows.length > 0 && JSON.stringify(singleRows) === JSON.stringify(singleControl),
	`${singleRows.length} vs ${singleControl.length}`
);

// A report publishes as numbered exhibits, not a grid.
const asReport = D.dashboardToMarkdown({
	catalog,
	dashboard: { ...forPublish, mode: 'report' },
	generatedOn: '2026-08-08'
});
check(
	'a report publishes numbered exhibits with source lines',
	/## Exhibit 1 — Over time/.test(asReport) &&
		/## Exhibit 2 — By status/.test(asReport) &&
		/Source: dbt_semantic\.orders/.test(asReport) &&
		!/<Grid/.test(asReport),
	(asReport.match(/## Exhibit \d+[^\n]*/g) ?? []).join(' | ')
);
check(
	'a report states its basis of preparation',
	/Basis of preparation/.test(asReport) && /unaudited/.test(asReport)
);

/* ------------------------------------------------------------------ done -- */

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
