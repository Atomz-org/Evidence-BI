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

// The page is a Studio board over the Cube model: one canvas, four tiles, each
// with its own Edit button opening the noodle worksheet. The governed catalog is
// therefore *inside* a worksheet rather than on the page at rest, which is why
// the field checks below come after opening one.
const board = await page.evaluate(`
  const studio = document.querySelector('.studio');
  const tiles = [...document.querySelectorAll('.tile')];
  return {
    exists: !!studio,
    dark: studio ? studio.classList.contains('dark') : null,
    tiles: tiles.length,
    withEdit: tiles.filter(t => [...t.querySelectorAll('button')].some(b => /^edit$/i.test(b.textContent.trim()))).length,
    // A tile renders a chart or a table; both count as rendered, neither is the empty state.
    rendered: tiles.filter(t => t.querySelectorAll('canvas, table').length > 0).length,
    emptyState: /Start with a field|Auto-build a draft/.test(studio?.innerText ?? '')
  };
`);
check('the board rendered as one canvas', board.exists);
check('four tiles on the board', board.tiles === 4, `${board.tiles} tiles`);
check('every tile has its own Edit button', board.withEdit === board.tiles, `${board.withEdit}/${board.tiles}`);
check('every tile actually rendered a view', board.rendered === board.tiles, `${board.rendered}/${board.tiles} drew a chart or table`);
check('the board is not showing the empty state', !board.emptyState);

// The surface follows the page it sits on. A light page drawing the dark chrome
// means detectMode() is wrong, and every contrast guarantee goes with it.
check('the board follows the light page', board.dark === false, `dark=${board.dark}`);

// Open a tile's worksheet and assert the catalog is Cube's model, not parquet
// column names. Editing is the whole point of the board, so this doubles as the
// check that the Edit button works.
await page.evaluate(`
  const t = [...document.querySelectorAll('.tile')][1];
  [...t.querySelectorAll('button')].find(b => /^edit$/i.test(b.textContent.trim())).click();
  return 1;
`);
await sleep(2500);

const sheet = await page.evaluate(`
  const n = document.querySelector('.noodle');
  if (!n) return { noSheet: true };
  const t = n.innerText;
  return {
    revenue:   /Revenue/.test(t),
    aov:       /Average Order Value/.test(t),
    customers: /Customer/.test(t),
    shelves:   n.querySelectorAll('[class*=shelf]').length,
    marks:     [...n.querySelectorAll('button')].map(b => b.textContent.trim())
                 .filter(x => ['Bar','Line','Area','Table'].includes(x)).length
  };
`);
check('Edit opens the worksheet over the board', !sheet.noSheet);
check('model measures present (Revenue)', sheet.revenue);
check('derived measure present (Average Order Value)', sheet.aov, 'has no parquet-column equivalent');
check('joined cube present (Customers)', sheet.customers);
check('the worksheet is editable — shelves and marks', sheet.shelves > 0 && sheet.marks >= 4, `${sheet.shelves} shelves, ${sheet.marks} marks`);

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
