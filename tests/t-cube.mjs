/**
 * Verify the noodle↔Cube integration against a **live Cube 1.7.17**, running in
 * a container over this project's parquet.
 *
 * Numbers coming back from Cube are compared to control queries computed
 * independently in DuckDB, so this checks the whole chain — meta → catalog,
 * shelves → Cube query, Cube's answer → noodle rows — not just its shape.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { boot } from './duck.mjs';

const ENGINE = `${ROOT}/components/noodle/engine`;
const { catalogFromCubeMeta, compileCubeQuery, createCubeClient, normalizeCubeResult, checkJoinable, formatFor } =
	await import(`${ENGINE}/cube.js`);
const { emptySpec, dropField, __resetPillCounter } = await import(`${ENGINE}/spec.js`);
const { recommend } = await import(`${ENGINE}/showme.js`);
const { applyTableCalcs } = await import(`${ENGINE}/tablecalc.js`);

const { run } = await boot();
__resetPillCounter();

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);
const near = (a, b, eps = 1e-6) => Math.abs((a ?? 0) - (b ?? 0)) <= eps * Math.max(1, Math.abs(b ?? 0));

const client = createCubeClient({ apiUrl: 'http://127.0.0.1:4000' });

/* ------------------------------------------------------ meta -> catalog -- */

const meta = await client.meta();
const catalog = catalogFromCubeMeta(meta);
const F = (id) => catalog.byId[id];

check('catalog is marked as semantic', catalog.source === 'cube');
check('cubes became tables', catalog.tables.map((t) => t.name).sort().join(',') === 'customers,orders');
check('measures carry Cube aggType', F('orders.revenue')?.aggType === 'sum');
check('measures are not re-aggregated by the shelf', F('orders.revenue')?.defaultAgg === null);
check('currency format mapped to Evidence', F('orders.revenue')?.format === 'usd0', F('orders.revenue')?.format);
check('calculated measure survives', F('orders.avg_order_value')?.role === 'measure');
check('time dimension typed as date', F('orders.ordered_at')?.dataType === 'date');
check('granularities exposed', (F('orders.ordered_at')?.granularities ?? []).includes('month'));
check('string dimension typed', F('orders.region')?.dataType === 'string');
check('segments captured', catalog.segments.map((s) => s.id).sort().join(',') === 'orders.not_cancelled,orders.paid_only');
check('join graph captured', catalog.tables.every((t) => t.connectedComponent === 1));
check('titles preferred over raw names', F('customers.country_code')?.name === 'Country', F('customers.country_code')?.name);

check('percent format maps', formatFor({ format: 'percent' }) === 'pct1');
check('currency precision honoured', formatFor({ format: 'currency_2', currency: 'EUR' }) === 'eur2');

/* -------------------------------------------- one dimension, one measure -- */

let spec = emptySpec();
spec = dropField(spec, catalog, F('orders.region'), 'columns');
spec = dropField(spec, catalog, F('orders.revenue'), 'rows');

{
	const { query, columns, warnings } = compileCubeQuery(catalog, spec);
	check('query names the measure', query?.measures?.[0] === 'orders.revenue', JSON.stringify(query));
	check('query names the dimension', query?.dimensions?.[0] === 'orders.region');
	check('no spurious warnings', warnings.length === 0, JSON.stringify(warnings));

	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);
	const control = await run(
		`select region, sum(order_amount_usd) v from dbt_semantic.orders group by 1 order by 1`
	);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));

	check('cube returned every region', rows.length === control.length, `${rows.length} vs ${control.length}`);
	check(
		'cube revenue matches DuckDB control',
		rows.length > 0 && rows.every((r) => near(Number(r['orders.revenue']), byRegion[r['orders.region']])),
		JSON.stringify(rows.slice(0, 2))
	);
}

/* ------------------------------------------------------ time granularity -- */

let trend = emptySpec();
trend = dropField(trend, catalog, F('orders.ordered_at'), 'columns');
trend = dropField(trend, catalog, F('orders.revenue'), 'rows');

{
	const { query, columns } = compileCubeQuery(catalog, trend);
	check('time dimension uses a granularity', query?.timeDimensions?.[0]?.granularity === 'month');

	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);
	const control = await run(
		`select date_trunc('month', ordered_at) m, sum(order_amount_usd) v
		 from dbt_semantic.orders group by 1 order by 1`
	);
	check('monthly grain matches control', rows.length === control.length, `${rows.length} vs ${control.length}`);
	check(
		'monthly values match control',
		rows.every((r, i) => near(Number(r['orders.revenue']), control[i].v)),
		JSON.stringify(rows.map((r) => r['orders.revenue']))
	);
	check(
		'dates revived as Date objects',
		rows.every((r) => r['orders.ordered_at.month'] instanceof Date)
	);
	check('Show Me still reads the shape', recommend(catalog, trend)[0].mark === 'line');
}

/* ------------------------------------------------------------- join ------ */

{
	let joined = emptySpec();
	joined = dropField(joined, catalog, F('customers.country_code'), 'columns');
	joined = dropField(joined, catalog, F('orders.revenue'), 'rows');

	const { query, columns } = compileCubeQuery(catalog, joined);
	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);

	const control = await run(
		`select c.country_code cc, sum(o.order_amount_usd) v
		 from dbt_semantic.orders o
		 left join dbt_semantic.customers c on o.customer_id = c.customer_id
		 group by 1 order by 1 nulls last`
	);
	const byCountry = Object.fromEntries(control.map((r) => [r.cc, r.v]));
	check(
		'cube resolved the join itself, values match',
		rows.length > 0 && rows.every((r) => near(Number(r['orders.revenue']), byCountry[r['customers.country_code']])),
		`${rows.length} rows vs ${control.length}`
	);
}

/* ------------------------------------------------------------ filters ---- */

{
	const filtered = {
		...spec,
		filters: [{ fieldId: 'orders.order_status', role: 'dimension', op: 'in', values: ['paid'] }]
	};
	const { query, columns } = compileCubeQuery(catalog, filtered);
	check('filter uses the Cube operator', query.filters[0].operator === 'equals', JSON.stringify(query.filters));

	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);
	const control = await run(
		`select region, sum(order_amount_usd) v from dbt_semantic.orders
		 where order_status = 'paid' group by 1 order by 1`
	);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));
	check(
		'filtered values match control',
		rows.length > 0 && rows.every((r) => near(Number(r['orders.revenue']), byRegion[r['orders.region']]))
	);
}

/* ----------------------------------------------------------- segments ---- */

{
	const segmented = { ...spec, segments: ['orders.not_cancelled'] };
	const { query, columns } = compileCubeQuery(catalog, segmented);
	check('segment passed through', query.segments?.[0] === 'orders.not_cancelled');

	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);
	const control = await run(
		`select region, sum(order_amount_usd) v from dbt_semantic.orders
		 where order_status <> 'cancelled' group by 1 order by 1`
	);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));
	check(
		'segment applied the model filter',
		rows.length > 0 && rows.every((r) => near(Number(r['orders.revenue']), byRegion[r['orders.region']]))
	);
}

/* ----------------------------------------- model-owned aggregation kept -- */

{
	// A modelled measure must not be re-aggregated by the shelf. Setting an agg
	// should warn and be ignored, and the number must still be Cube's.
	let overridden = emptySpec();
	overridden = dropField(overridden, catalog, F('orders.region'), 'columns');
	overridden = dropField(overridden, catalog, F('orders.avg_order_value'), 'rows');
	overridden.rows[0].agg = 'sum';

	const { query, columns, warnings } = compileCubeQuery(catalog, overridden);
	check('overriding a modelled aggregation warns', warnings.some((w) => w.includes('comes from the model')));

	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);
	const control = await run(
		`select region, sum(order_amount_usd) / nullif(count(*), 0) v
		 from dbt_semantic.orders group by 1 order by 1`
	);
	const byRegion = Object.fromEntries(control.map((r) => [r.region, r.v]));
	check(
		'calculated measure equals the model definition',
		rows.length > 0 && rows.every((r) => near(Number(r['orders.avg_order_value']), byRegion[r['orders.region']], 1e-6)),
		JSON.stringify(rows.slice(0, 2))
	);
}

/* -------------------------------------------- table calcs over Cube rows -- */

{
	const calcSpec = structuredClone({ ...trend, filters: [] });
	calcSpec.rows[0].calc = { type: 'runningTotal' };
	const { query, columns } = compileCubeQuery(catalog, calcSpec);
	const response = await client.load(query);
	const { rows } = normalizeCubeResult(response, columns);
	const applied = applyTableCalcs(rows, columns);

	const total = await run(`select sum(order_amount_usd) v from dbt_semantic.orders`);
	const last = applied.rows.at(-1)?.['orders.revenue'];
	check(
		'running total over Cube rows ends at the grand total',
		near(Number(last), total[0].v),
		`${last} vs ${total[0].v}`
	);
}

/* --------------------------------------------------- unjoinable cubes ---- */

{
	const split = {
		...catalog,
		tables: catalog.tables.map((t) => (t.name === 'customers' ? { ...t, connectedComponent: 2 } : t))
	};
	const verdict = checkJoinable(split, ['orders.revenue', 'customers.country_code']);
	check('disconnected cubes are refused with a reason', !verdict.ok && verdict.reason.includes('not joined'));
}

/* ------------------------------------------------------ the SQL Cube runs -- */

{
	const { query } = compileCubeQuery(catalog, spec);
	const sql = await client.sql(query);
	const text = sql?.sql?.sql?.[0] ?? '';
	check('Cube exposes the SQL it runs', /select/i.test(text), text.slice(0, 120));
}

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
