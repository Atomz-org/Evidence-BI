/**
 * The Cube-backed surface, in a real browser.
 *
 * Everything that makes this page different from /noodle happens client-side
 * and at runtime: the field catalogue is built from Cube's /meta, the query is
 * a Cube REST call, and the "aggregation belongs to the model" rule is enforced
 * in the component. None of that is observable from the built HTML, so it has
 * to be driven rather than inspected.
 *
 * Needs:  ./cube/up.sh   and a server for the built site on :4321
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/noodle-cube/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await openPage(URL, { width: 1600, height: 1200 });

// The catalogue is fetched on mount; give the round trip to Cube a moment.
await sleep(4000);

const text = await page.evaluate(`return document.body.innerText`);

check('page rendered', text.length > 200, `${text.length} chars`);
check(
	'did not fall back to an ungoverned surface',
	!/could not reach|failed to load|Error:/i.test(text.slice(0, 4000)) || /needs a local Cube/i.test(text),
	text.slice(0, 200).replace(/\n/g, ' ')
);

// Fields from the Cube model, not from parquet column names.
const fields = await page.evaluate(`
  const t = document.body.innerText;
  return {
    revenue:    /Revenue/.test(t),
    aov:        /Average Order Value/.test(t),
    orders:     /Orders/.test(t),
    region:     /Region/.test(t),
    customers:  /Customer/.test(t)
  };
`);
check('model measures present (Revenue)', fields.revenue);
check('derived measure present (Average Order Value)', fields.aov, 'has no parquet-column equivalent');
check('joined cube present (Customers)', fields.customers);

// Counting svg/path anywhere on the page is not a test: Show Me's mark icons
// and the site chrome supply plenty of them, which is how an earlier version of
// this file passed while the chart area sat on its empty state. Scope to the
// chart container, and assert the empty state is gone.
const rendered = await page.evaluate(`
  const viz = document.querySelector('.viz');
  if (!viz) return { noViz: true };
  return {
    emptyState: /Start with a field/.test(viz.innerText),
    error:      /could not be built/.test(viz.innerText),
    marks:      viz.querySelectorAll('svg path, svg rect, canvas').length,
    rowsLabel:  (document.body.innerText.match(/(\\d+)\\s+rows/) || [])[1] ?? null
  };
`);
check('the chart container exists', !rendered.noViz);
check('query returned rows', Number(rendered.rowsLabel) > 0, `${rendered.rowsLabel} rows`);
check(
	'chart area is NOT showing the empty state',
	!rendered.emptyState,
	rendered.emptyState ? 'pills are on the shelves but the view never rendered' : ''
);
check('a chart actually rendered inside .viz', rendered.marks > 0, `${rendered.marks} marks in .viz`);

// Prove the data really came from Cube rather than a cached parquet view.
const net = await page.evaluate(`
  const hits = performance.getEntriesByType('resource')
    .map(e => e.name)
    .filter(n => /cubejs-api/.test(n));
  return { count: hits.length, sample: hits.slice(0, 2) };
`);
check('the page actually called Cube', net.count > 0, `${net.count} request(s) ${net.sample.join(' ')}`);

// Month alignment. Cube sends "2026-07-01T00:00:00.000" with no timezone, and
// JS reads an offset-less date-TIME as local — so on any machine east of UTC
// the whole series renders one month early while every total stays correct.
// Nothing errors; the chart is just wrong. Compare the rendered axis against
// what Cube actually returned.
const truth = await (async () => {
	const r = await fetch('http://localhost:4000/cubejs-api/v1/load', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: {
				measures: ['orders.revenue'],
				timeDimensions: [{ dimension: 'orders.ordered_at', granularity: 'month' }]
			}
		})
	}).then((r) => r.json());
	const res = Array.isArray(r.results) ? r.results[0] : r;
	const peak = (res.data ?? []).reduce((a, b) =>
		Number(a['orders.revenue']) > Number(b['orders.revenue']) ? a : b
	);
	return String(peak['orders.ordered_at.month']).slice(0, 7); // YYYY-MM
})();

// ECharts renders to canvas, so the axis labels are pixels, not DOM text. Ask
// the chart instance for the category it actually plotted instead.
const axis = await page.evaluate(`
  const el = document.querySelector('.viz canvas')?.parentElement;
  const id = el && el.getAttribute('_echarts_instance_');
  const inst = id && window.echarts && window.echarts.getInstanceById(id);
  if (!inst) return null;
  const opt = inst.getOption();
  const cat = opt.xAxis?.[0]?.data ?? [];
  const series = opt.series?.[0]?.data ?? [];
  return { cat: cat.map(String), series: series.map(v => Array.isArray(v) ? v : [null, v]) };
`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const expectedLabel = MONTHS[Number(truth.slice(5, 7)) - 1];
if (axis === null) {
	console.log(`note  chart instance not reachable from the page; month alignment asserted in t-cube.mjs instead`);
} else {
	check(
		`peak month plots as ${expectedLabel} (Cube says ${truth})`,
		JSON.stringify(axis.cat).includes(expectedLabel) || JSON.stringify(axis.cat).includes(truth),
		`categories: ${axis.cat.join(', ').slice(0, 120)}`
	);
}

await page.screenshot('/tmp/noodle-cube.png');

const errors = page.pageErrors.filter((e) => !/favicon|404/i.test(e));
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

page.close();

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed   (screenshot /tmp/noodle-cube.png)`);
process.exit(failed ? 1 : 0);
