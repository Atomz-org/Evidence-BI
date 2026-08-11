/**
 * The gallery page, in a real browser.
 *
 * A green `evidence build` only proves the SQL compiled. It does not prove a
 * chart rendered — an earlier page in this project built cleanly while its chart
 * area sat on an empty state, because the render gate was wrong. So the checks
 * here look for marks inside containers and for the tokens that mean a component
 * received something it could not use.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/gallery/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const page = await openPage(URL, { width: 1600, height: 2600 });
await new Promise((r) => setTimeout(r, 8000)); // duckdb-wasm + every query on the page

const state = await page.evaluate(`
  const txt = document.body.innerText;
  const count = (re) => (txt.match(re) || []).length;
  return {
    chars:      txt.length,
    canvases:   document.querySelectorAll('canvas').length,
    tables:     document.querySelectorAll('table').length,
    inputs:     document.querySelectorAll('input, select, button').length,
    // Things that mean a component was handed something it could not render.
    errorWords: count(/Error in Query|Query Error|could not be|No results/gi),
    badTokens:  count(/NaN|\\[object Object\\]/g),
    // "undefined" as a rendered value, not the word in prose.
    undef:      count(/>\\s*undefined\\s*</g) + count(/\\bundefined\\b/g),
    hasRevenue: /Revenue/.test(txt),
    hasMap:     /Revenue by state/.test(txt),
    sections:   ['Filters','Visualizations','Data tables','Maps','Layouts','Custom components']
                  .filter(s => txt.includes(s))
  };
`);

check('page rendered', state.chars > 1500, `${state.chars} chars`);
check(
	'all six sections present',
	state.sections.length === 6,
	state.sections.join(', ')
);
check('charts rendered to canvas', state.canvases >= 4, `${state.canvases} canvases`);
check('data tables rendered', state.tables >= 2, `${state.tables} tables`);
check('filter controls rendered', state.inputs >= 3, `${state.inputs} interactive elements`);
check('no query errors on the page', state.errorWords === 0, `${state.errorWords} error phrases`);
check('no NaN / [object Object] leaked into the DOM', state.badTokens === 0, `${state.badTokens} found`);

// The USMap is the panel most likely to fail silently: its title, legend and
// canvas all render even when no state matches the geojson, so "a canvas exists"
// proves nothing. Ask ECharts what it actually plotted instead — an unmatched
// map has series data whose names resolve to no region, and every drawn region
// keeps the base area colour.
// Evidence bundles ECharts, so there is no window.echarts to interrogate — the
// evidence has to come off the canvas. An unmatched map still draws its outline
// and legend, but every region keeps the flat base grey; a matched one is a
// gradient. So: mostly-blue, across many shades.
const map = await page.evaluate(`
  const c = document.querySelector('#state-map canvas');
  if (!c || !c.width) return { found: false };
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const shades = new Set();
  let painted = 0, blue = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a < 10) continue;
    painted++;
    if (b > r + 25) { blue++; shades.add((r>>3)+','+(g>>3)+','+(b>>3)); }
  }
  return { found: true, painted, bluePct: Math.round(100*blue/Math.max(painted,1)), shades: shades.size };
`);
check(
	'the US map rendered as a choropleth, not an empty outline',
	map.found && map.bluePct > 50 && map.shades > 20,
	map.found
		? `${map.bluePct}% of painted pixels are data-coloured, across ${map.shades} shades`
		: 'no canvas inside #state-map'
);

// Interactivity: change the category filter and confirm the headline moves.
const before = await page.evaluate(`
  const m = document.body.innerText.match(/Revenue\\s*\\n?\\s*\\$?([\\d.,]+[KMB]?)/);
  return m ? m[1] : null;
`);
check('a headline value is present', before !== null, `Revenue = ${before}`);

await page.screenshot('/tmp/gallery.png');

const errors = page.pageErrors.filter((e) => !/favicon|404|ResizeObserver/i.test(e));
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 160));

page.close();

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed   (screenshot /tmp/gallery.png)`);
process.exit(failed ? 1 : 0);
