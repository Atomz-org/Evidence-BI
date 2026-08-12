/**
 * The unified board's engine, checked against the data.
 *
 * Two things here are worth more than the rest.
 *
 * **The pivot's totals.** Adding a column of numbers is so obviously right that
 * the mistake survives review, and it is wrong for every measure that is not a
 * plain sum. The tests below do not check that the totals "look right" — they
 * check that the total differs from what adding the cells would have produced,
 * and that it equals a control query written against the raw parquet. A test
 * that only checked agreement would pass just as happily on a pivot that summed
 * everything, because for revenue summing is correct.
 *
 * **The semantic types.** flint-chart derives zero baselines and axis behaviour
 * from what a column means, and those meanings are inferred from the metrics
 * view rather than restated per chart. If the inference drifts, nothing breaks
 * — the charts just quietly stop starting at zero.
 *
 *   node tests/t-canvas.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, '.evidence/template');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
	try {
		await fn();
		passed += 1;
	} catch (e) {
		failures.push(`${name}\n    ${e.message}`);
	}
};
const assert = (ok, message) => {
	if (!ok) throw new Error(message);
};
const near = (a, b, tol = 1e-9) =>
	a === null || b === null ? a === b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/* -------------------------------------------------------------------- data -- */

const duck = await import(path.join(ROOT, 'node_modules/@evidence-dev/universal-sql/src/client-duckdb/node.js'));
await duck.initDB();
const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'static/data/manifest.json'), 'utf8'));
await duck.setParquetURLs(
	Object.fromEntries(
		Object.entries(manifest.renderedFiles).map(([s, f]) => [s, f.map((x) => path.join(TEMPLATE, x))])
	)
);
const run = async (sql) =>
	JSON.parse(JSON.stringify(await duck.query(sql), (k, v) => (typeof v === 'bigint' ? Number(v) : v)));

const { RILL } = await import(path.join(ROOT, 'components/rill/model.generated.js'));
const M = await import(path.join(ROOT, 'components/rill/engine/metrics.js'));
const T = await import(path.join(ROOT, 'components/rill/engine/timerange.js'));
const P = await import(path.join(ROOT, 'components/canvas/pivot.js'));

const view = RILL.metricsViews.orders_metrics;
const board = RILL.canvases.executive;

await run(M.createViewSql(view, RILL.models));
const [b] = await run(M.boundsSql(view));
const bounds = { min: new Date(b.lo), max: new Date(b.hi) };
const range = T.resolveRange('inf', bounds, view.smallestTimeGrain);
const windowed = T.resolveRange('P4W', bounds, view.smallestTimeGrain);
const filters = {};

/* ------------------------------------------------------------- the layout -- */

await check('the board compiled and is current with canvas/', () => {
	execFileSync('node', [path.join(ROOT, 'scripts/build-rill-model.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
	assert(board, 'no canvas named executive');
});

await check('no row is wider than twelve columns', () => {
	board.rows.forEach((row, i) => {
		const width = row.items.reduce((n, item) => n + item.width, 0);
		assert(width <= 12, `row ${i + 1} sums to ${width}`);
	});
});

await check('every tile references fields the metrics view actually has', () => {
	const known = new Set([...view.measures, ...view.dimensions].map((f) => f.name));
	for (const row of board.rows) {
		for (const item of row.items) {
			const referenced = [
				item.config.measure,
				item.config.dimension,
				item.config.series,
				item.config.y,
				...(item.config.measures ?? []),
				...(item.config.dimensions ?? []),
				...(item.config.rows ?? []),
				...(item.config.columns ?? [])
			].filter(Boolean);
			for (const name of referenced) assert(known.has(name), `${item.component} names "${name}"`);
		}
	}
});

await check('extensions are marked as extensions', () => {
	// The `x_` prefix is the promise that `rill start` is not expected to render
	// these. If a tile ever ships unmarked, that promise is quietly broken.
	for (const row of board.rows) {
		for (const item of row.items) {
			assert(
				item.extension === item.component.startsWith('x_'),
				`${item.component} is marked extension=${item.extension}`
			);
		}
	}
	assert(
		board.rows.flatMap((r) => r.items).some((i) => i.extension),
		'the board should exercise at least one extension'
	);
});

/** Compile a temporary canvas and return the generator's complaint, if any. */
const rejects = (mutate) => {
	const file = path.join(ROOT, 'canvas/executive.yaml');
	const original = fs.readFileSync(file, 'utf8');
	try {
		fs.writeFileSync(file, mutate(original));
		try {
			execFileSync('node', [path.join(ROOT, 'scripts/build-rill-model.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
			return null;
		} catch (e) {
			return String(e.stderr ?? e.stdout ?? e.message);
		}
	} finally {
		fs.writeFileSync(file, original);
	}
};

await check('a component Rill and this project both lack is refused', () => {
	const complaint = rejects((s) => s.replace('      - kpi_grid:', '      - sankey_chart:'));
	assert(complaint, 'an unknown component compiled');
	assert(/neither a Rill canvas component/.test(complaint), `wrong message: ${complaint}`);
});

await check('a row wider than twelve columns is refused', () => {
	const complaint = rejects((s) => s.replace('      - width: 7\n        line_chart:', '      - width: 9\n        line_chart:'));
	assert(complaint && /twelve columns/.test(complaint), `got: ${complaint}`);
});

await check('a heatmap with only one categorical axis is refused', () => {
	// A heatmap needs two. Given one it silently renders as something else,
	// which is how a broken tile ships looking merely odd.
	const complaint = rejects((s) => s.replace('          y: order_status\n', ''));
	assert(complaint && /two categorical axes/.test(complaint), `got: ${complaint}`);
});

await check('a tile naming a measure that does not exist is refused', () => {
	const complaint = rejects((s) => s.replace('          measure: revenue\n          series: region', '          measure: profit\n          series: region'));
	assert(complaint && /not a measure/.test(complaint), `got: ${complaint}`);
});

/* ------------------------------------------------------- semantic types -- */

await check('semantic types are inferred from the metrics view, not restated', () => {
	const tile = board.rows.flatMap((r) => r.items).find((i) => i.component === 'line_chart');
	const expected = {
		revenue: 'Amount', // currency_usd
		cancellation_rate: 'Percentage', // percentage
		orders: 'Count',
		region: 'Region',
		country_code: 'Country',
		order_size: 'Category',
		order_status: 'Status',
		bucket: 'Date'
	};
	for (const [column, want] of Object.entries(expected)) {
		assert(tile.types[column] === want, `${column} typed ${tile.types[column]}, expected ${want}`);
	}
});

await check('a currency measure is typed for a zero baseline', async () => {
	// The reason typing matters at all: Amount has a meaningful zero, so a bar
	// half as tall means half as much money. Flint is the authority on that
	// mapping, so ask it rather than asserting the project's belief about it.
	const flint = await import('flint-chart');
	assert(flint.getZeroClass('Amount') === 'meaningful', `Amount zero class is ${flint.getZeroClass('Amount')}`);
	assert(flint.getZeroClass('Temperature') !== 'meaningful', 'Temperature must not claim a meaningful zero');
});

await check('every inferred type is a name flint actually registers', async () => {
	const flint = await import('flint-chart');
	const registered = new Set(Object.values(flint.SemanticTypes));
	const used = new Set(board.rows.flatMap((r) => r.items).flatMap((i) => Object.values(i.types)));
	for (const type of used) assert(registered.has(type), `"${type}" is not a flint semantic type — it would be ignored`);
});

/* ---------------------------------------------------------------- the grid -- */

await check('a heatmap query groups by both of its axes', async () => {
	const sql = M.gridSql(view, {
		dimensions: ['order_size', 'order_status'],
		measures: ['revenue'],
		range,
		filters
	});
	const rows = await run(sql);
	const control = await run(`
		select count(*) as n from (
			select 1 from dbt_semantic.orders
			group by case when order_amount_usd >= 500 then 'Large'
			              when order_amount_usd >= 100 then 'Medium' else 'Small' end, order_status
		)
	`);
	assert(rows.length === control[0].n, `${rows.length} cells vs ${control[0].n} combinations`);
});

await check('the notebook scan carries the board window and filters', async () => {
	const scoped = { region: { mode: 'include', values: ['EMEA'] } };
	const scan = M.scanSubquery(view, { range: windowed, filters: scoped });
	const [{ n }] = await run(`select count(*) as n from ${scan}`);
	const [control] = await run(`
		select count(*) as n from dbt_semantic.orders
		where region = 'EMEA'
		  and ordered_at >= ${T.sqlTimestamp(windowed.start)} and ordered_at < ${T.sqlTimestamp(windowed.end)}
	`);
	assert(n === control.n, `${n} rows through the scan, ${control.n} in the control`);
	assert(n > 0 && n < 492, 'the scan neither dropped everything nor filtered nothing');
});

/* --------------------------------------------------------------- the pivot -- */

const pivotArgs = { rows: ['region'], columns: ['order_status'], measures: ['revenue', 'avg_order_value'] };
const pivotRows = await run(P.pivotSql(view, { ...pivotArgs, range, filters, totals: true }));
const g = P.shapePivot(pivotRows, { ...pivotArgs, totals: true });

await check('the pivot has a cell for every combination that exists', async () => {
	const leaves = g.rowKeys.filter((k) => !P.isTotalKey(k)).length * g.colKeys.filter((k) => !P.isTotalKey(k)).length;
	const [{ n }] = await run(
		`select count(*) as n from (select 1 from dbt_semantic.orders group by region, order_status)`
	);
	assert(leaves >= n, `${leaves} cells for ${n} populated combinations`);
});

await check('every pivot cell equals an independent control', async () => {
	const control = await run(`
		select region, order_status,
		       sum(order_amount_usd) as revenue,
		       sum(order_amount_usd) / nullif(count(*), 0) as aov
		from dbt_semantic.orders group by 1, 2
	`);
	for (const row of control) {
		const cellRevenue = g.cell([row.region], [row.order_status], 'revenue');
		const cellAov = g.cell([row.region], [row.order_status], 'avg_order_value');
		assert(near(cellRevenue, row.revenue), `${row.region}/${row.order_status} revenue ${cellRevenue} vs ${row.revenue}`);
		assert(near(cellAov, row.aov), `${row.region}/${row.order_status} aov ${cellAov} vs ${row.aov}`);
	}
});

await check('a row total is the measure over the whole row, not the sum of its cells', async () => {
	const [control] = await run(`
		select sum(order_amount_usd) / nullif(count(*), 0) as aov
		from dbt_semantic.orders where region = 'EMEA'
	`);
	const total = g.cell(['EMEA'], [P.TOTAL], 'avg_order_value');
	assert(near(total, control.aov), `row total ${total} vs control ${control.aov}`);

	// And it is genuinely different from the naive answer — otherwise this test
	// would pass on an implementation that just averaged the cells.
	const cells = g.colKeys
		.filter((k) => !P.isTotalKey(k))
		.map((ck) => g.cell(['EMEA'], ck, 'avg_order_value'))
		.filter((v) => v !== null);
	const naive = cells.reduce((a, x) => a + x, 0) / cells.length;
	assert(Math.abs(naive - total) > 1e-6, `averaging the cells gives ${naive}, the same as the total — nothing is being tested`);
});

await check('the grand total is the measure over everything', async () => {
	const [control] = await run(`
		select sum(order_amount_usd) as revenue, sum(order_amount_usd) / nullif(count(*), 0) as aov
		from dbt_semantic.orders
	`);
	assert(near(g.cell([P.TOTAL], [P.TOTAL], 'revenue'), control.revenue), 'revenue grand total');
	assert(near(g.cell([P.TOTAL], [P.TOTAL], 'avg_order_value'), control.aov), 'aov grand total');
});

await check('an additive measure still adds up — the totals are not merely different', () => {
	// The counterpart to the test above: for a sum, the computed total and the
	// added cells must agree. A pivot that got totals "wrong in a new way" would
	// fail here.
	const cells = g.colKeys
		.filter((k) => !P.isTotalKey(k))
		.map((ck) => g.cell(['EMEA'], ck, 'revenue') ?? 0);
	const added = cells.reduce((a, x) => a + x, 0);
	const total = g.cell(['EMEA'], [P.TOTAL], 'revenue');
	assert(near(added, total, 1e-9), `cells add to ${added}, total says ${total}`);
});

await check('a distinct count total never exceeds the whole', async () => {
	const args = { rows: ['region'], columns: [], measures: ['customers'] };
	const rows = await run(P.pivotSql(view, { ...args, range, filters, totals: true }));
	const grid = P.shapePivot(rows, { ...args, totals: true });
	const parts = grid.rowKeys.filter((k) => !P.isTotalKey(k)).map((k) => grid.cell(k, [], 'customers') ?? 0);
	const total = grid.cell([P.TOTAL], [], 'customers');
	const [control] = await run('select count(distinct customer_id) as n from dbt_semantic.orders');
	assert(near(total, control.n), `total ${total} vs control ${control.n}`);
	assert(
		total <= parts.reduce((a, x) => a + x, 0),
		'a distinct-count total cannot exceed the sum of its parts'
	);
});

await check('totals: false emits only the cells', async () => {
	const rows = await run(P.pivotSql(view, { ...pivotArgs, range, filters, totals: false }));
	const grid = P.shapePivot(rows, { ...pivotArgs, totals: false });
	assert(!grid.rowKeys.some(P.isTotalKey), 'a total row survived');
	assert(!grid.colKeys.some(P.isTotalKey), 'a total column survived');
});

await check('the totals are ordered last, not wherever the sort left them', () => {
	assert(P.isTotalKey(g.rowKeys.at(-1)), `last row is ${JSON.stringify(g.rowKeys.at(-1))}`);
	assert(P.isTotalKey(g.colKeys.at(-1)), `last column is ${JSON.stringify(g.colKeys.at(-1))}`);
	assert(!g.rowKeys.slice(0, -1).some(P.isTotalKey), 'a total appeared mid-grid, where it reads as data');
});

await check('the pivot honours a filter from elsewhere on the board', async () => {
	const scoped = { order_status: { mode: 'exclude', values: ['cancelled'] } };
	const rows = await run(P.pivotSql(view, { ...pivotArgs, range, filters: scoped, totals: true }));
	const grid = P.shapePivot(rows, { ...pivotArgs, totals: true });
	assert(!grid.colKeys.some((k) => k[0] === 'cancelled'), 'the excluded status is still a column');
	const [control] = await run(
		`select sum(order_amount_usd) as revenue from dbt_semantic.orders where order_status <> 'cancelled'`
	);
	assert(near(grid.cell([P.TOTAL], [P.TOTAL], 'revenue'), control.revenue), 'the grand total ignored the filter');
});

/* ------------------------------------------------------------------ report -- */

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`\n  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
