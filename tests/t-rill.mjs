/**
 * The Rill layer, checked against the data rather than against itself.
 *
 * Compiling a semantic layer to SQL is only worth doing if the numbers it
 * produces are provably the ones the YAML declared. So almost nothing here
 * asserts on the generated SQL's *text*: each query is run against the project's
 * real parquet and compared with a control query written independently, against
 * `dbt_semantic.orders` directly, without touching the compiled view. If the
 * compiler and the control ever disagree, one of them is wrong and the test says
 * which numbers.
 *
 * Three things get harder treatment because they are the ones that fail
 * silently:
 *
 *   * the comparison window, where an off-by-one boundary shifts every delta;
 *   * timezone handling, invisible in a UTC-only test run;
 *   * `valid_percent_of_total`, where the wrong answer is a plausible number.
 *
 *   node tests/t-rill.mjs
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
const near = (a, b, tol = 1e-9) => {
	if (a === null || b === null || a === undefined || b === undefined) return a === b;
	return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
};

/* -------------------------------------------------------------------- data -- */

const duck = await import(path.join(ROOT, 'node_modules/@evidence-dev/universal-sql/src/client-duckdb/node.js'));
await duck.initDB();
const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'static/data/manifest.json'), 'utf8'));
await duck.setParquetURLs(
	Object.fromEntries(
		Object.entries(manifest.renderedFiles).map(([source, files]) => [source, files.map((f) => path.join(TEMPLATE, f))])
	)
);
const run = async (sql) =>
	JSON.parse(JSON.stringify(await duck.query(sql), (k, v) => (typeof v === 'bigint' ? Number(v) : v)));

const { RILL } = await import(path.join(ROOT, 'components/rill/model.generated.js'));
const M = await import(path.join(ROOT, 'components/rill/engine/metrics.js'));
const T = await import(path.join(ROOT, 'components/rill/engine/timerange.js'));
const F = await import(path.join(ROOT, 'components/rill/engine/format.js'));
const { compile } = await import(path.join(ROOT, 'components/noodle/engine/compile.js'));

const view = RILL.metricsViews.orders_metrics;
const explore = RILL.explores.revenue;

/* ------------------------------------------------------------- the project -- */

await check('the compiled module is current with rill/', () => {
	// Generated code that is committed is only safe if staleness is caught. This
	// is that catch: it is why `npm run rill:model` can be forgotten once.
	execFileSync('node', [path.join(ROOT, 'scripts/build-rill-model.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
});

await check('the model rewrote every parquet path to an Evidence table', () => {
	const model = RILL.models[view.model];
	assert(!/read_parquet/i.test(model.sql.replace(/--[^\n]*/g, '')), 'a read_parquet() call survived the rewrite');
	assert(model.sources.includes('dbt_semantic.orders'), `sources were ${model.sources.join(', ')}`);
});

await check('the generator rejects an unsound percent-of-total claim', () => {
	// The rule is the point of the generator, so it is tested by breaking it
	// rather than by reading the code that implements it.
	const file = path.join(ROOT, 'rill/metrics/orders_metrics.yaml');
	const original = fs.readFileSync(file, 'utf8');
	try {
		fs.writeFileSync(
			file,
			original.replace(
				'    expression: count(distinct customer_id)',
				'    expression: count(distinct customer_id)\n    valid_percent_of_total: true'
			)
		);
		let threw = null;
		try {
			execFileSync('node', [path.join(ROOT, 'scripts/build-rill-model.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
		} catch (e) {
			threw = String(e.stderr ?? e.stdout ?? e.message);
		}
		assert(threw, 'the generator accepted a distinct count as additive');
		assert(/does not add up across a partition/.test(threw), `wrong message: ${threw}`);
	} finally {
		fs.writeFileSync(file, original);
	}
});

await check('the explore only offers fields the metrics view defines', () => {
	const names = new Set([...view.dimensions, ...view.measures].map((f) => f.name));
	for (const f of [...explore.dimensions, ...explore.measures, ...explore.defaults.measures, ...explore.defaults.dimensions]) {
		assert(names.has(f), `"${f}" is on the explore but not in the metrics view`);
	}
});

/* -------------------------------------------------------------------- view -- */

await run(M.createViewSql(view, RILL.models));
const [rawBounds] = await run(M.boundsSql(view));
const bounds = { min: new Date(rawBounds.lo), max: new Date(rawBounds.hi) };

await check('the view has one row per order — the join did not fan out', async () => {
	const [{ n }] = await run(`select count(*) as n from ${M.viewName(view)}`);
	const [{ orders }] = await run('select count(*) as orders from dbt_semantic.orders');
	assert(n === orders, `${n} rows on the view for ${orders} orders`);
});

await check('an expression dimension is materialised as a real column', async () => {
	const rows = await run(`select distinct order_size from ${M.viewName(view)} order by 1`);
	assert(rows.length === 3, `expected three bands, got ${rows.map((r) => r.order_size).join(', ')}`);
});

/* ------------------------------------------------------------ time ranges -- */

await check('every range the explore offers resolves inside the data', () => {
	for (const token of explore.timeRanges) {
		const range = T.resolveRange(token, bounds, view.smallestTimeGrain);
		assert(range.end > range.start, `${token} produced an empty window`);
		assert(range.end > bounds.max, `${token} ends before the newest row`);
		assert(range.grain === 'day' || range.grain === 'week' || range.grain === 'month', `${token} chose grain ${range.grain}`);
	}
});

await check('a range is anchored to the newest row, not to the clock', () => {
	const range = T.resolveRange('P7D', bounds, 'day');
	const days = (range.end - range.start) / 86400000;
	assert(days === 7, `P7D spanned ${days} days`);
	assert(range.end - bounds.max < 86400000, 'the window does not end at the data');
	// The distinguishing property: today is well past the data, and it makes no
	// difference. Anchoring to `now` would put the whole window past the last row.
	assert(range.start <= bounds.max && range.end > bounds.max, 'the newest row is outside the window');
});

await check('a partial comparison window is reported, not hidden', () => {
	const range = T.resolveRange('P4W', bounds, 'day');
	assert(range.comparison, 'P4W has some history behind it and should offer a comparison');
	assert(range.comparisonCoverage > 0 && range.comparisonCoverage < 1, `coverage was ${range.comparisonCoverage}`);
	assert(/reads high/.test(range.comparisonNote ?? ''), `no caution: ${range.comparisonNote}`);
});

await check('a comparison with no history at all is withheld', () => {
	const range = T.resolveRange('P3M', bounds, 'day');
	assert(!range.comparison, 'offered a comparison window that is entirely outside the data');
	assert(/nothing precedes/i.test(range.comparisonNote ?? ''), `no explanation: ${range.comparisonNote}`);
});

await check('the range boundaries are identical in five timezones', () => {
	// A naive TIMESTAMP compared against a literal built from local components
	// shifts by the machine's offset. In UTC — where CI runs — nothing is wrong,
	// which is exactly why this needs asserting somewhere other than UTC.
	const zones = ['UTC', 'Europe/Oslo', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'];
	const original = process.env.TZ;
	const seen = new Map();
	try {
		for (const zone of zones) {
			process.env.TZ = zone;
			const range = T.resolveRange('P4W', bounds, 'day');
			seen.set(zone, [T.sqlTimestamp(range.start), T.sqlTimestamp(range.end), T.sqlTimestamp(range.comparison.start)].join(' | '));
		}
	} finally {
		process.env.TZ = original;
	}
	const distinct = new Set(seen.values());
	assert(
		distinct.size === 1,
		`boundaries differ by timezone:\n      ${[...seen].map(([z, v]) => `${z}: ${v}`).join('\n      ')}`
	);
});

await check('a calendar month is a calendar month, not thirty days', () => {
	const from = new Date('2026-03-31T00:00:00Z');
	assert(
		T.subtract(from, T.parseDuration('P1M')).toISOString().startsWith('2026-02-28'),
		'one month before 31 March should clamp to 28 February'
	);
});

/* ------------------------------------------------ measures, against control -- */

const range = T.resolveRange('P4W', bounds, view.smallestTimeGrain);
const measures = view.measures.map((m) => m.name);
const filters = {};

const controlWhere = (start, end, extra = '') =>
	`ordered_at >= ${T.sqlTimestamp(start)} and ordered_at < ${T.sqlTimestamp(end)}${extra}`;

/** Every measure, recomputed from the raw parquet rather than the generated view. */
const controlMeasures = async (where) =>
	(
		await run(`
			select sum(order_amount_usd)                                            as revenue,
			       sum(net_line_amount_usd)                                         as net_revenue,
			       count(*)                                                         as orders,
			       sum(line_item_count)                                             as line_items,
			       count(distinct customer_id)                                      as customers,
			       sum(order_amount_usd) / nullif(count(*), 0)                      as avg_order_value,
			       count(*) filter (where order_status = 'cancelled')
			         / nullif(count(*)::double, 0)                                  as cancellation_rate
			from dbt_semantic.orders
			where ${where}
		`)
	)[0];

await check('every headline measure matches an independent control', async () => {
	const rows = await run(M.totalsSql(view, { range, measures, filters }));
	const current = rows.find((r) => r._window === 'current');
	const control = await controlMeasures(controlWhere(range.start, range.end));
	const wrong = measures.filter((name) => !near(current[name], control[name]));
	assert(!wrong.length, wrong.map((n) => `${n}: ${current[n]} vs ${control[n]}`).join('; '));
});

await check('the comparison window is the period immediately before, and is right', async () => {
	const rows = await run(M.totalsSql(view, { range, measures, filters }));
	const previous = rows.find((r) => r._window === 'comparison');
	const control = await controlMeasures(controlWhere(range.comparison.start, range.comparison.end));
	const wrong = measures.filter((name) => !near(previous[name], control[name]));
	assert(!wrong.length, wrong.map((n) => `${n}: ${previous[n]} vs ${control[n]}`).join('; '));
	// The two windows must not overlap by so much as an instant, or the delta
	// double-counts the boundary bucket.
	assert(
		range.comparison.end.getTime() === range.start.getTime(),
		'the comparison window does not end exactly where the current one begins'
	);
});

await check('the two windows partition the scan — no row is in both or neither', async () => {
	const rows = await run(M.totalsSql(view, { range, measures: ['orders'], filters }));
	const total = rows.reduce((n, r) => n + r.orders, 0);
	const [{ n }] = await run(
		`select count(*) as n from dbt_semantic.orders where ${controlWhere(range.comparison.start, range.end)}`
	);
	assert(total === n, `${total} rows across both windows for ${n} in the scan`);
});

await check('the series sums to the headline', async () => {
	const rows = await run(M.seriesSql(view, { range, measures: ['revenue'], filters }));
	const summed = rows.filter((r) => r._window === 'current').reduce((s, r) => s + r.revenue, 0);
	const [total] = await run(M.totalsSql(view, { range, measures: ['revenue'], filters }));
	const headline = (await run(M.totalsSql(view, { range, measures: ['revenue'], filters }))).find(
		(r) => r._window === 'current'
	).revenue;
	assert(near(summed, headline, 1e-9), `buckets sum to ${summed}, headline is ${headline}`);
	assert(total, 'no totals row');
});

await check('a filter reaches every panel identically', async () => {
	const scoped = { order_status: { mode: 'exclude', values: ['cancelled'] } };
	const [totals] = (await run(M.totalsSql(view, { range, measures: ['revenue'], filters: scoped }))).filter(
		(r) => r._window === 'current'
	);
	const control = await controlMeasures(controlWhere(range.start, range.end, " and order_status <> 'cancelled'"));
	assert(near(totals.revenue, control.revenue), `${totals.revenue} vs ${control.revenue}`);

	const board = await run(
		M.leaderboardSql(view, { dimension: 'region', measure: 'revenue', range, filters: scoped })
	);
	const boardSum = board.reduce((s, r) => s + (r.current ?? 0), 0);
	assert(near(boardSum, control.revenue), `leaderboard sums to ${boardSum}, headline is ${control.revenue}`);
});

/* ------------------------------------------------------------ leaderboards -- */

await check('a leaderboard matches a control, ranked', async () => {
	const rows = await run(M.leaderboardSql(view, { dimension: 'region', measure: 'revenue', range, filters }));
	const control = await run(`
		select region as value, sum(order_amount_usd) as revenue
		from dbt_semantic.orders
		where ${controlWhere(range.start, range.end)}
		group by 1 order by 2 desc
	`);
	assert(rows.length === control.length, `${rows.length} values vs ${control.length}`);
	rows.forEach((row, i) => {
		assert(row.value === control[i].value, `rank ${i}: ${row.value} vs ${control[i].value}`);
		assert(near(row.current, control[i].revenue), `${row.value}: ${row.current} vs ${control[i].revenue}`);
	});
});

await check('a leaderboard ignores a filter on its own dimension', async () => {
	// Otherwise it collapses to the one value already selected, and there is no
	// way to add a second without clearing the filter blind.
	const scoped = { region: { mode: 'include', values: ['EMEA'] } };
	const rows = await run(M.leaderboardSql(view, { dimension: 'region', measure: 'revenue', range, filters: scoped }));
	assert(rows.length > 1, `only ${rows.length} value(s) left visible`);

	// ...but a different board must honour it.
	const other = await run(
		M.leaderboardSql(view, { dimension: 'order_status', measure: 'revenue', range, filters: scoped })
	);
	const control = await controlMeasures(controlWhere(range.start, range.end, " and region = 'EMEA'"));
	const sum = other.reduce((s, r) => s + (r.current ?? 0), 0);
	assert(near(sum, control.revenue), `order_status board sums to ${sum}, EMEA revenue is ${control.revenue}`);
});

await check('a value present only in the comparison window still appears', async () => {
	// Ranking happens before the limit, and the limit is generous; a segment that
	// collapsed to nothing is exactly what the board should be showing.
	const rows = await run(M.leaderboardSql(view, { dimension: 'country_code', measure: 'revenue', range, filters }));
	const withNoCurrent = rows.filter((r) => r.current === null && r.comparison !== null);
	const [{ n }] = await run(`
		select count(*) as n from (
		  select country_code from (
		    select coalesce(c.country_code,'unknown') as country_code, o.ordered_at
		    from dbt_semantic.orders o left join dbt_semantic.customers c using (customer_id)
		  )
		  where ordered_at >= ${T.sqlTimestamp(range.comparison.start)} and ordered_at < ${T.sqlTimestamp(range.start)}
		  except
		  select country_code from (
		    select coalesce(c.country_code,'unknown') as country_code, o.ordered_at
		    from dbt_semantic.orders o left join dbt_semantic.customers c using (customer_id)
		  )
		  where ordered_at >= ${T.sqlTimestamp(range.start)} and ordered_at < ${T.sqlTimestamp(range.end)}
		)
	`);
	assert(withNoCurrent.length === n, `${withNoCurrent.length} lapsed values shown, ${n} exist`);
});

await check('percent-of-total is offered only where it is sound', () => {
	const total = 1000;
	const additive = view.measures.find((m) => m.name === 'revenue');
	const distinct = view.measures.find((m) => m.name === 'customers');
	const ratio = view.measures.find((m) => m.name === 'avg_order_value');
	assert(F.percentOfTotal(250, total, additive) === 0.25, 'revenue should carry a share');
	assert(F.percentOfTotal(250, total, distinct) === null, 'a distinct count must not');
	assert(F.percentOfTotal(250, total, ratio) === null, 'a ratio must not');
});

await check('leaderboard shares sum to one for an additive measure', async () => {
	const rows = await run(M.leaderboardSql(view, { dimension: 'region', measure: 'revenue', range, filters }));
	const total = rows.reduce((s, r) => s + (r.current ?? 0), 0);
	const shares = rows.map((r) => F.percentOfTotal(r.current, total, view.measures.find((m) => m.name === 'revenue')));
	assert(near(shares.reduce((a, b) => a + b, 0), 1, 1e-9), `shares summed to ${shares.reduce((a, b) => a + b, 0)}`);
});

/* ------------------------------------------------------------------ detail -- */

await check('the split-by-dimension detail sums back to the leaderboard', async () => {
	const board = await run(M.leaderboardSql(view, { dimension: 'region', measure: 'revenue', range, filters }));
	const values = board.slice(0, 2).map((r) => r.value);
	const rows = await run(M.detailSql(view, { dimension: 'region', measure: 'revenue', range, filters, values }));
	for (const value of values) {
		const summed = rows.filter((r) => r.value === value).reduce((s, r) => s + r.revenue, 0);
		const expected = board.find((r) => r.value === value).current;
		assert(near(summed, expected), `${value}: buckets sum to ${summed}, board says ${expected}`);
	}
});

/* ------------------------------------------------------------------ noodle -- */

const catalog = M.catalogFromMetricsView(view, RILL.models);

await check('the noodle catalog carries every field the metrics view declares', () => {
	for (const d of view.dimensions) assert(catalog.byId[`${M.viewName(view)}.${d.name}`], `missing dimension ${d.name}`);
	for (const m of view.measures) {
		const field = catalog.byId[`${M.viewName(view)}.${m.name}`];
		assert(field, `missing measure ${m.name}`);
		assert(field.aggExpression === m.expression, `${m.name} carries "${field.aggExpression}" not "${m.expression}"`);
		assert(field.defaultAgg === null && field.semantic, `${m.name} should be locked to the model`);
	}
});

const specWith = (fieldIds) => ({
	columns: fieldIds.slice(0, 1).map((id, i) => ({ key: `d${i}`, fieldId: id, role: 'dimension' })),
	rows: fieldIds.slice(1).map((id, i) => ({ key: `m${i}`, fieldId: id, role: 'measure', agg: null })),
	detail: [],
	tooltip: [],
	filters: [],
	color: null,
	size: null,
	label: null,
	source: { primary: null, joins: [] }
});

await check('a governed ratio compiles to the governed expression, not to a re-derivation', async () => {
	const table = M.viewName(view);
	const compiled = compile(catalog, specWith([`${table}.region`, `${table}.avg_order_value`]));
	assert(compiled.sql, `nothing compiled: ${compiled.warnings.join('; ')}`);
	assert(
		compiled.sql.includes('sum(order_amount_usd) / nullif(count(*), 0)'),
		`the expression was rebuilt:\n${compiled.sql}`
	);
	const rows = await run(compiled.sql);
	const control = await run(`
		select region, sum(order_amount_usd) / nullif(count(*), 0) as aov
		from dbt_semantic.orders group by 1 order by 1
	`);
	assert(rows.length === control.length, `${rows.length} vs ${control.length} rows`);
	rows.forEach((row, i) => assert(near(row.avg_order_value, control[i].aov), `${row.region}: ${row.avg_order_value} vs ${control[i].aov}`));
});

await check('a shelf aggregation cannot override the model', async () => {
	const table = M.viewName(view);
	const spec = specWith([`${table}.region`, `${table}.avg_order_value`]);
	spec.rows[0].agg = 'sum'; // as if the pill menu had been used
	const compiled = compile(catalog, spec);
	assert(
		!/sum\(\s*"avg_order_value"\s*\)/i.test(compiled.sql),
		`the shelf's aggregation reached the SQL:\n${compiled.sql}`
	);
	assert(compiled.sql.includes('nullif(count(*), 0)'), 'the governed expression was dropped');
});

await check('a binned dimension cannot steal a governed measure’s input column', async () => {
	// The failure this guards: `order_amount_usd` bucketed into a dimension takes
	// the identity alias in `base`, and `sum(order_amount_usd)` then sums the
	// bucket boundaries. Nothing errors; revenue is simply wrong.
	const table = M.viewName(view);
	const binned = {
		...specWith([`${table}.region`, `${table}.revenue`]),
		columns: [{ key: 'd0', fieldId: `${table}.order_size`, role: 'dimension' }]
	};
	const compiled = compile(catalog, binned);
	const rows = await run(compiled.sql);
	const total = rows.reduce((s, r) => s + r.revenue, 0);
	const [{ revenue }] = await run('select sum(order_amount_usd) as revenue from dbt_semantic.orders');
	assert(near(total, revenue), `bands sum to ${total}, actual revenue is ${revenue}`);
});

await check('a governed measure refuses to be recomputed at another level of detail', () => {
	const table = M.viewName(view);
	const spec = specWith([`${table}.region`, `${table}.avg_order_value`]);
	spec.rows[0].lod = { kind: 'FIXED', dims: [`${table}.order_status`], agg: 'sum' };
	const compiled = compile(catalog, spec);
	assert(
		compiled.warnings.some((w) => /semantic layer/i.test(w)),
		`no warning; got ${JSON.stringify(compiled.warnings)}`
	);
});

/* ----------------------------------------------------------------- formats -- */

await check('Rill format presets render the way Rill renders them', () => {
	const usd = { formatPreset: 'currency_usd' };
	const pct = { formatPreset: 'percentage' };
	const num = { formatPreset: 'humanize' };
	const cases = [
		[F.formatMeasure(1234567.89, usd, { compact: true }), '$1.2M'],
		[F.formatMeasure(1234.5, usd), '$1,235'],
		[F.formatMeasure(88.5, usd), '$88.50'],
		[F.formatMeasure(-2500, usd, { compact: true }), '-$2.5k'],
		[F.formatMeasure(0.0572, pct), '5.72%'],
		[F.formatMeasure(0.0025, pct), '0.25%'],
		[F.formatMeasure(0.572, pct), '57.2%'],
		[F.formatMeasure(492, num, { compact: true }), '492'],
		[F.formatMeasure(null, num), '—']
	];
	for (const [got, want] of cases) assert(got === want, `got ${got}, want ${want}`);
});

await check('a percentage keeps three significant figures at any magnitude', () => {
	// The rule, rather than four remembered values: precision follows magnitude,
	// so a rate is never rounded to the point where two different rates print the
	// same and never padded with digits nobody can act on.
	const pct = { formatPreset: 'percentage' };
	for (const [fraction, want] of [[0.0025, 3], [0.0572, 3], [0.572, 3], [0.9999, 3]]) {
		const digits = F.formatMeasure(fraction, pct).replace(/[^0-9]/g, '').replace(/^0+/, '').length;
		assert(digits <= want, `${fraction} rendered as ${F.formatMeasure(fraction, pct)} — ${digits} significant digits`);
	}
	assert(F.formatMeasure(0.0572, pct) !== F.formatMeasure(0.0568, pct), 'two different rates printed the same');
});

await check('humanize carries into the next suffix instead of printing 1000k', () => {
	assert(F.humanize(999999) === '1M', `got ${F.humanize(999999)}`);
	assert(F.humanize(999) === '999', `got ${F.humanize(999)}`);
	assert(F.humanize(1500) === '1.5k', `got ${F.humanize(1500)}`);
	assert(F.humanize(-1500000) === '-1.5M', `got ${F.humanize(-1500000)}`);
});

await check('a change against zero reports no percentage rather than an invented one', () => {
	const zero = F.delta(40, 0);
	assert(zero.absolute === 40 && zero.relative === null, `got ${JSON.stringify(zero)}`);
	const none = F.delta(40, null);
	assert(none.absolute === null && none.direction === null, 'a missing comparison is not a change of zero');
});

await check('lower_is_better reverses which direction reads as good', () => {
	const rate = view.measures.find((m) => m.name === 'cancellation_rate');
	const revenue = view.measures.find((m) => m.name === 'revenue');
	assert(rate.lowerIsBetter, 'cancellation_rate should be declared lower_is_better');
	assert(F.isFavourable('up', rate) === false, 'a rising cancellation rate is not good news');
	assert(F.isFavourable('down', rate) === true);
	assert(F.isFavourable('up', revenue) === true);
	assert(F.isFavourable('flat', revenue) === null, 'flat is neither');
});

/* ------------------------------------------------------------------ report -- */

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`\n  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
