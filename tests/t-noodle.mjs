/**
 * Integration test for the noodle engine.
 *
 * Every assertion runs the compiler's SQL against the project's real parquet and
 * compares it to an independently hand-written control query. String-matching
 * generated SQL would prove only that it looks right.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { boot } from './duck.mjs';

const ENGINE = `${ROOT}/components/noodle/engine`;
const { buildCatalog } = await import(`${ENGINE}/catalog.js`);
const { compile } = await import(`${ENGINE}/compile.js`);
const { emptySpec, makePill, dropField, __resetPillCounter } = await import(`${ENGINE}/spec.js`);
const { applyTableCalcs, computeSeries } = await import(`${ENGINE}/tablecalc.js`);
const { recommend, resolveMark } = await import(`${ENGINE}/showme.js`);

const { run } = await boot();
__resetPillCounter();

const catalog = await buildCatalog(run, {
	tables: ['dbt_semantic.orders', 'dbt_semantic.customers'],
	relationships: [
		{
			from: 'dbt_semantic.orders',
			to: 'dbt_semantic.customers',
			on: [['customer_id', 'customer_id']],
			type: 'left'
		}
	],
	fields: {
		'dbt_semantic.customers.region': { name: 'Customer Region' }
	}
});

const F = (id) => {
	const f = catalog.byId[id];
	if (!f) throw new Error(`no field ${id}`);
	return f;
};

const checks = [];
const check = (name, ok, detail = '') => {
	checks.push([name, !!ok, detail]);
};
const near = (a, b, eps = 1e-6) => Math.abs((a ?? 0) - (b ?? 0)) <= eps * Math.max(1, Math.abs(b ?? 0));

const exec = async (spec, label) => {
	const compiled = compile(catalog, spec);
	if (!compiled.sql) {
		check(`${label}: compiles`, false, compiled.warnings.join('; '));
		return { rows: [], compiled };
	}
	try {
		const rows = await run(compiled.sql);
		return { rows, compiled };
	} catch (e) {
		check(`${label}: executes`, false, `${e.message}\n${compiled.sql}`);
		return { rows: [], compiled };
	}
};

/* ------------------------------------------------------------- catalog --- */

check('measure detected', F('dbt_semantic.orders.order_amount_usd').role === 'measure');
check('currency format inferred', F('dbt_semantic.orders.order_amount_usd').format === 'usd0');
check('id column is a dimension', F('dbt_semantic.orders.customer_id').role === 'dimension');
check('timestamp classified', F('dbt_semantic.orders.ordered_date').dataType === 'date');
check('override applied', F('dbt_semantic.customers.region').name === 'Customer Region');
check('humanized name', F('dbt_semantic.orders.order_amount_usd').name === 'Order Amount USD');

/* ------------------------------------------- 1 dimension, 1 measure ------ */

let spec = emptySpec('dbt_semantic.orders');
spec = dropField(spec, catalog, F('dbt_semantic.orders.region'), 'columns');
spec = dropField(spec, catalog, F('dbt_semantic.orders.order_amount_usd'), 'rows');

{
	const { rows, compiled } = await exec(spec, 'region x revenue');
	const control = await run(
		`select region, sum(order_amount_usd) v from dbt_semantic.orders group by 1 order by 1`
	);
	const measureAlias = compiled.columns.find((c) => c.role === 'measure')?.alias;
	check('region x revenue: row count', rows.length === control.length, `${rows.length} vs ${control.length}`);
	check(
		'region x revenue: values match control',
		control.every((c, i) => rows[i]?.region === c.region && near(rows[i]?.[measureAlias], c.v))
	);
}

/* -------------------------------------------------- temporal grain ------- */

let trend = emptySpec('dbt_semantic.orders');
trend = dropField(trend, catalog, F('dbt_semantic.orders.ordered_date'), 'columns');
trend = dropField(trend, catalog, F('dbt_semantic.orders.order_amount_usd'), 'rows');

{
	const { rows, compiled } = await exec(trend, 'month trend');
	const control = await run(
		`select date_trunc('month', ordered_date) m, sum(order_amount_usd) v
		 from dbt_semantic.orders group by 1 order by 1`
	);
	const alias = compiled.columns.find((c) => c.role === 'measure')?.alias;
	check('month trend: grain matches', rows.length === control.length, `${rows.length} vs ${control.length}`);
	check('month trend: values match', control.every((c, i) => near(rows[i]?.[alias], c.v)));
	check('month trend: ordered ascending', rows.every((r, i) => i === 0 || r.ordered_date_month >= rows[i - 1].ordered_date_month));
}

/* ---------------------------------------------------- cross-table join --- */

let joined = emptySpec('dbt_semantic.orders');
joined = dropField(joined, catalog, F('dbt_semantic.customers.country_code'), 'columns');
joined = dropField(joined, catalog, F('dbt_semantic.orders.order_amount_usd'), 'rows');

{
	const { rows, compiled } = await exec(joined, 'join to customers');
	const control = await run(
		`select c.country_code cc, sum(o.order_amount_usd) v
		 from dbt_semantic.orders o
		 left join dbt_semantic.customers c on o.customer_id = c.customer_id
		 group by 1 order by 1 nulls last`
	);
	const alias = compiled.columns.find((c) => c.role === 'measure')?.alias;
	check('join: row count', rows.length === control.length, `${rows.length} vs ${control.length}`);
	check('join: values match', control.every((c, i) => near(rows[i]?.[alias], c.v)));
	check('join: only one join emitted', (compiled.sql.match(/left join "dbt_semantic"."customers"/g) ?? []).length === 1);
}

/* ------------------------------------------------------------ filters --- */

{
	const filtered = {
		...spec,
		filters: [
			{ fieldId: 'dbt_semantic.orders.order_status', role: 'dimension', op: 'in', values: ['paid'] }
		]
	};
	const { rows, compiled } = await exec(filtered, 'filter in');
	const control = await run(
		`select region, sum(order_amount_usd) v from dbt_semantic.orders
		 where order_status in ('paid') group by 1 order by 1`
	);
	const alias = compiled.columns.find((c) => c.role === 'measure')?.alias;
	check('filter: values match', control.length > 0 && control.every((c, i) => near(rows[i]?.[alias], c.v)));

	const injected = {
		...spec,
		filters: [
			{ fieldId: 'dbt_semantic.orders.order_status', role: 'dimension', op: 'eq', values: ["x') or 1=1 --"] }
		]
	};
	const { rows: none } = await exec(injected, 'filter injection');
	check('filter: literal escaped, no injection', none.length === 0);
}

/* --------------------------------------------------------------- LOD ---- */
// View at region x month; FIXED [region] must repeat the region total on every
// month, and equal the independently computed region total.

let lodSpec = emptySpec('dbt_semantic.orders');
lodSpec = dropField(lodSpec, catalog, F('dbt_semantic.orders.ordered_date'), 'columns');
lodSpec = dropField(lodSpec, catalog, F('dbt_semantic.orders.region'), 'rows');
lodSpec = dropField(lodSpec, catalog, F('dbt_semantic.orders.order_amount_usd'), 'rows');

const withLod = (kind, dims, outerAgg = 'avg') => {
	const pill = makePill(F('dbt_semantic.orders.order_amount_usd'), {
		agg: outerAgg,
		lod: { kind, dims, agg: 'sum', fieldId: 'dbt_semantic.orders.order_amount_usd' }
	});
	return { ...lodSpec, rows: [...lodSpec.rows, pill] };
};

{
	const { rows, compiled } = await exec(withLod('FIXED', ['dbt_semantic.orders.region']), 'LOD FIXED');
	const lodAlias = compiled.columns.filter((c) => c.role === 'measure').at(-1)?.alias;
	const control = await run(
		`select region, sum(order_amount_usd) v from dbt_semantic.orders group by 1`
	);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));
	check(
		'LOD FIXED: equals the region total on every row',
		rows.length > 0 && rows.every((r) => near(r[lodAlias], byRegion[r.region]))
	);
	const distinctPerRegion = new Set(rows.map((r) => `${r.region}|${Math.round(r[lodAlias])}`));
	check('LOD FIXED: constant within a region', distinctPerRegion.size === Object.keys(byRegion).length);
}

{
	// EXCLUDE [month] over a region x month view leaves the region grain, so it
	// must agree with FIXED [region] exactly.
	const { rows, compiled } = await exec(
		withLod('EXCLUDE', ['dbt_semantic.orders.ordered_date']),
		'LOD EXCLUDE'
	);
	const lodAlias = compiled.columns.filter((c) => c.role === 'measure').at(-1)?.alias;
	const control = await run(`select region, sum(order_amount_usd) v from dbt_semantic.orders group by 1`);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));
	check(
		'LOD EXCLUDE: drops month, equals region total',
		rows.length > 0 && rows.every((r) => near(r[lodAlias], byRegion[r.region]))
	);
}

{
	// INCLUDE [order_status] at region x month, outer AVG: the mean of the
	// per-status sums inside each region-month cell.
	const { rows, compiled } = await exec(
		withLod('INCLUDE', ['dbt_semantic.orders.order_status']),
		'LOD INCLUDE'
	);
	const lodAlias = compiled.columns.filter((c) => c.role === 'measure').at(-1)?.alias;
	const control = await run(
		`with inner_grain as (
		   select date_trunc('month', ordered_date) m, region, order_status, sum(order_amount_usd) v
		   from dbt_semantic.orders group by 1,2,3
		 )
		 select m, region, avg(v) v from inner_grain group by 1,2`
	);
	const key = (m, r) => `${new Date(m).toISOString()}|${r}`;
	const expected = Object.fromEntries(control.map((r) => [key(r.m, r.region), r.v]));
	check(
		'LOD INCLUDE: mean of per-status sums',
		rows.length > 0 &&
			rows.every((r) => near(r[lodAlias], expected[key(r.ordered_date_month, r.region)]))
	);
}

/* ------------------------------------------------------- table calcs ---- */

check('running total accumulates', JSON.stringify(computeSeries([1, 2, 3], { type: 'runningTotal' })) === '[1,3,6]');
check('moving average trails', JSON.stringify(computeSeries([2, 4, 6], { type: 'movingAverage', window: 2 })) === '[2,3,5]');
check('percent of total sums to 1', near(computeSeries([1, 3], { type: 'percentOfTotal' }).reduce((a, b) => a + b, 0), 1));
check('difference from previous', JSON.stringify(computeSeries([5, 8, 6], { type: 'difference' })) === '[null,3,-2]');
check('rank ties share a rank', JSON.stringify(computeSeries([10, 10, 5], { type: 'rank' })) === '[1,1,3]');

{
	// A running total partitioned by region, addressed along month, must end at
	// each region's grand total — and must survive transposing the view.
	const calcPill = makePill(F('dbt_semantic.orders.order_amount_usd'), {
		agg: 'sum',
		calc: { type: 'runningTotal' }
	});
	const calcSpec = { ...lodSpec, rows: [lodSpec.rows[0], calcPill] };

	const { rows, compiled } = await exec(calcSpec, 'running total');
	const alias = compiled.columns.filter((c) => c.role === 'measure').at(-1)?.alias;
	const applied = applyTableCalcs(rows, compiled.columns);

	const control = await run(`select region, sum(order_amount_usd) v from dbt_semantic.orders group by 1`);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));

	// The endpoint of a running total is the value at the last addressing value
	// (the latest month), not the last row in result order.
	const endpoint = (rows, valueAlias) => {
		const best = {};
		for (const row of rows) {
			const key = row.region;
			if (!best[key] || row.ordered_date_month > best[key].m) best[key] = { m: row.ordered_date_month, v: row[valueAlias] };
		}
		return Object.fromEntries(Object.entries(best).map(([k, x]) => [k, x.v]));
	};

	const ends = endpoint(applied.rows, alias);
	check(
		'running total: ends at the region total',
		Object.keys(byRegion).length > 0 &&
			Object.entries(byRegion).every(([region, total]) => near(ends[region], total))
	);
	check('running total: base value retained for tooltips', applied.rows.every((r) => `${alias}__base` in r));

	// Transpose: the calculation addresses a *field*, not a screen direction, so
	// every cell must come back with exactly the same value.
	const transposed = { ...calcSpec, columns: calcSpec.rows, rows: calcSpec.columns };
	const t = await exec(transposed, 'running total transposed');
	const tAlias = t.compiled.columns.filter((c) => c.role === 'measure').at(-1)?.alias;
	const tApplied = applyTableCalcs(t.rows, t.compiled.columns);

	const cellMap = (rows, valueAlias) =>
		Object.fromEntries(rows.map((r) => [`${r.region}|${r.ordered_date_month}`, r[valueAlias]]));
	const before = cellMap(applied.rows, alias);
	const after = cellMap(tApplied.rows, tAlias);
	check(
		'running total: survives transposing the view',
		Object.keys(before).length > 0 &&
			Object.keys(before).length === Object.keys(after).length &&
			Object.entries(before).every(([k, v]) => near(after[k], v))
	);
}

/* ---------------------------------------------------------- show me ----- */

{
	const trendRec = recommend(catalog, trend);
	check('show me: date -> line first', trendRec[0].mark === 'line', trendRec[0]?.reason);

	const barRec = recommend(catalog, spec);
	check('show me: category+measure -> bar', barRec[0].mark === 'bar', barRec[0]?.reason);

	const wideRec = recommend(catalog, spec, { 'dbt_semantic.orders.region': { distinct: 40 } });
	check('show me: wide category -> horizontal bar', wideRec[0].mark === 'hbar', wideRec[0]?.reason);

	const hugeRec = recommend(catalog, spec, { 'dbt_semantic.orders.region': { distinct: 400 } });
	check('show me: very wide -> table', hugeRec[0].mark === 'table', hugeRec[0]?.reason);

	let kpi = emptySpec('dbt_semantic.orders');
	kpi = dropField(kpi, catalog, F('dbt_semantic.orders.order_amount_usd'), 'rows');
	check('show me: no dimension -> number', recommend(catalog, kpi)[0].mark === 'bigvalue');

	let matrix = emptySpec('dbt_semantic.orders');
	matrix = dropField(matrix, catalog, F('dbt_semantic.orders.region'), 'columns');
	matrix = dropField(matrix, catalog, F('dbt_semantic.orders.order_status'), 'rows');
	matrix = dropField(matrix, catalog, F('dbt_semantic.orders.order_amount_usd'), 'rows');
	check('show me: two categories -> heatmap', recommend(catalog, matrix)[0].mark === 'heatmap');

	check('every recommendation explains itself', recommend(catalog, trend).every((r) => r.reason?.length > 20));
	check('explicit mark wins over auto', resolveMark(catalog, { ...trend, mark: 'bar' }) === 'bar');
}

/* -------------------------------------------------- unreachable table --- */

{
	const orphanCatalog = { ...catalog, relationships: [] };
	const compiled = compile(orphanCatalog, joined);
	check(
		'unrelated table is reported, not silently joined',
		compiled.warnings.some((w) => w.includes('no declared relationship'))
	);
}

/* ------------------------------------------------------------ report ---- */

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
