/**
 * The anomaly screen exists twice, and this is what stops that being a problem.
 *
 * `pages/notebooks/order-anomalies.ipynb` states the method in pandas. The
 * page's `screen` query states it again in SQL, so the two decisions that carry
 * the analysis — the history window and the threshold — can be changed by a
 * reader instead of being frozen into a committed cell output.
 *
 * Two expressions of one method are a liability the moment nobody checks they
 * still agree. This runs the SQL against the project's real parquet, runs an
 * independent transcription of the notebook's pandas over the same rows, and
 * requires them to match on every row at every window the page offers. A
 * transcription is not the pandas itself — but it is written from the notebook
 * rather than from the SQL, so the two can only agree by both being right about
 * the method.
 *
 *   node tests/t-screen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, '.evidence/template');

/** The windows the page's ButtonGroup offers, and the min_periods the notebook fixes. */
const WINDOWS = [14, 28, 56];
const MIN_PERIODS = 14;

let passed = 0;
const failures = [];
const check = (name, fn) => {
	try {
		fn();
		passed += 1;
	} catch (e) {
		failures.push(`${name}\n    ${e.message}`);
	}
};
const assert = (ok, message) => {
	if (!ok) throw new Error(message);
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
const run = async (sql) => JSON.parse(JSON.stringify(await duck.query(sql), (k, v) => (typeof v === 'bigint' ? Number(v) : v)));

/* --------------------------------------------------------------------- SQL -- */

/**
 * Lifted from the notebook page's `screen` query. Kept here as a literal rather
 * than parsed out of the .ipynb: a test that reads the thing it is testing can
 * only ever agree with it.
 */
const screenSql = (windowDays) => `
with base as (
    select ordered_date as order_date,
           sum(order_amount_usd) as revenue,
           count(order_id) as orders
    from dbt_semantic.orders
    where order_status <> 'cancelled'
    group by 1
),
seasonal as (
    select *,
           median(revenue) over (partition by dayofweek(order_date))
             / nullif(median(revenue) over (), 0) as dow_factor
    from base
),
adjusted as (
    select *, revenue / nullif(dow_factor, 0) as adjusted from seasonal
),
centred as (
    select *,
           case when count(adjusted) over w >= ${MIN_PERIODS}
                then median(adjusted) over w end as med
    from adjusted
    window w as (order by order_date rows between (${windowDays} - 1) preceding and current row)
),
spread as (
    select *, abs(adjusted - med) as dev from centred
),
scored as (
    select *,
           case when count(dev) over w >= ${MIN_PERIODS}
                then median(dev) over w end as mad
    from spread
    window w as (order by order_date rows between (${windowDays} - 1) preceding and current row)
)
select order_date, revenue, orders,
       med * dow_factor as expected,
       0.6745 * (adjusted - med) / nullif(mad, 0) as robust_z
from scored
order by order_date
`;

/* ------------------------------------------- the notebook's pandas, in JS -- */

const median = (xs) => {
	const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
	if (!v.length) return NaN;
	const mid = v.length >> 1;
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/** pandas `.rolling(window, min_periods).median()` — trailing, current row included. */
const rollingMedian = (xs, window, minPeriods) =>
	xs.map((_, i) => {
		const slice = xs.slice(Math.max(0, i - window + 1), i + 1).filter((x) => x !== null && !Number.isNaN(x));
		return slice.length >= minPeriods ? median(slice) : NaN;
	});

/**
 * Cell 4 of the notebook, line for line:
 *   dow_factor = median revenue of this weekday / median revenue overall
 *   adjusted   = revenue / dow_factor
 *   expected   = rolling median of adjusted, re-seasonalized
 *   robust_z   = 0.6745 * (adjusted - med) / MAD
 */
const reference = (rows, windowDays) => {
	const revenue = rows.map((r) => r.revenue);
	const globalMedian = median(revenue);

	const byDow = new Map();
	rows.forEach((r, i) => {
		const d = new Date(r.order_date).getUTCDay();
		if (!byDow.has(d)) byDow.set(d, []);
		byDow.get(d).push(revenue[i]);
	});
	const dowMedian = new Map([...byDow].map(([d, xs]) => [d, median(xs)]));
	const dowFactor = rows.map((r) => dowMedian.get(new Date(r.order_date).getUTCDay()) / globalMedian);

	const adjusted = revenue.map((v, i) => v / dowFactor[i]);
	const med = rollingMedian(adjusted, windowDays, MIN_PERIODS);
	const dev = adjusted.map((v, i) => Math.abs(v - med[i]));
	const mad = rollingMedian(dev, windowDays, MIN_PERIODS);

	return rows.map((r, i) => ({
		order_date: r.order_date,
		expected: med[i] * dowFactor[i],
		robust_z: mad[i] === 0 ? NaN : (0.6745 * (adjusted[i] - med[i])) / mad[i]
	}));
};

const missing = (x) => x === null || x === undefined || Number.isNaN(x);
const close = (a, b, tol = 1e-9) => {
	if (missing(a) && missing(b)) return true;
	if (missing(a) !== missing(b)) return false;
	return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
};

/* ------------------------------------------------------------------- tests -- */

const daily = await run(`
    select ordered_date as order_date, sum(order_amount_usd) as revenue
    from dbt_semantic.orders
    where order_status <> 'cancelled'
    group by 1
    order by 1
`);

check('the parquet has enough history to score', () => {
	assert(daily.length > MIN_PERIODS * 2, `only ${daily.length} days — run npm run sources`);
});

for (const windowDays of WINDOWS) {
	const sqlRows = await run(screenSql(windowDays));
	const refRows = reference(daily, windowDays);

	check(`window ${windowDays}: the SQL screen covers every day`, () => {
		assert(sqlRows.length === daily.length, `${sqlRows.length} scored rows for ${daily.length} days`);
	});

	check(`window ${windowDays}: SQL and the notebook's method agree on every row`, () => {
		const wrong = [];
		for (let i = 0; i < sqlRows.length; i += 1) {
			if (!close(sqlRows[i].expected, refRows[i].expected) || !close(sqlRows[i].robust_z, refRows[i].robust_z)) {
				wrong.push(
					`${new Date(sqlRows[i].order_date).toISOString().slice(0, 10)}: ` +
						`expected ${sqlRows[i].expected} vs ${refRows[i].expected}, ` +
						`z ${sqlRows[i].robust_z} vs ${refRows[i].robust_z}`
				);
			}
		}
		assert(wrong.length === 0, `${wrong.length} of ${sqlRows.length} rows differ\n    ${wrong.slice(0, 3).join('\n    ')}`);
	});

	check(`window ${windowDays}: the unscored head is left unscored, not zeroed`, () => {
		// A day with too little history behind it has no expectation. Reporting 0
		// there would put a spurious anomaly at the start of every series.
		const head = sqlRows.slice(0, MIN_PERIODS - 1);
		assert(
			head.every((r) => r.robust_z === null || Number.isNaN(r.robust_z)),
			`${head.filter((r) => r.robust_z !== null).length} of the first ${MIN_PERIODS - 1} days carry a score`
		);
	});
}

const narrow = await run(screenSql(14));
const wide = await run(screenSql(56));

check('a wider window makes the expectation steadier', () => {
	// Not a restatement of the method but a property of it, and the reason the
	// control is worth putting on the page: a longer trailing median chases the
	// noise less, so its day-to-day movement is smaller.
	const wobble = (rows) => {
		const series = rows.map((r) => r.expected).filter((v) => v !== null && !Number.isNaN(v));
		const steps = series.slice(1).map((v, i) => Math.abs(v - series[i]));
		return steps.reduce((a, b) => a + b, 0) / steps.length;
	};
	const a = wobble(narrow);
	const b = wobble(wide);
	assert(b < a, `56-day expectation moves ${b.toFixed(0)}/day, 14-day moves ${a.toFixed(0)}/day`);
});

check('the window control actually changes the answer', () => {
	const z = (rows) => rows.filter((r) => r.robust_z !== null && !Number.isNaN(r.robust_z)).map((r) => r.robust_z);
	const a = z(narrow);
	const b = z(wide);
	assert(a.length > 0 && b.length > 0, 'one of the windows scored nothing');
	const differing = a.filter((v, i) => b[i] !== undefined && Math.abs(v - b[i]) > 1e-9).length;
	assert(differing > 0, 'the 14-day and 56-day screens produced identical scores');
});

/* ------------------------------------------------------------------ report -- */

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`\n  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
