/**
 * The Flint charting page, in a real browser.
 *
 * `npm run test:flint` proves the option is correct; `evidence build` proves the
 * SQL compiled. Neither proves a chart *painted* — Flint's layout runs against a
 * measured container width, so a chart that never gets a width, or gets one after
 * the render gate has already passed, produces a clean build and a blank box.
 *
 * So these checks sample the actual canvas: is anything drawn on it, and are the
 * pixels the project's hues rather than ECharts' stock palette.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 *   node tests/t-flint-ui.mjs
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/flint/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const page = await openPage(URL, { width: 1500, height: 3200 });

// A thrown evaluate below would otherwise skip page.close() and leave Chrome
// running. cdp.mjs reuses one single-instance profile, so the leaked browser
// keeps the lock and it is the NEXT suite that fails to launch, a long way
// from the assertion that actually broke.
let failed = [];
try {
	await page.sleep(9000); // duckdb-wasm boot, then every query on the page

	const state = await page.evaluate(`
	  const text = document.body.innerText;
	  const canvases = [...document.querySelectorAll('.flint-canvas canvas')];

	  // A blank canvas is uniform. Sample a grid of pixels and count distinct
	  // colours — a painted chart has many, an empty one has one or two.
	  const sample = (canvas) => {
	    const ctx = canvas.getContext('2d');
	    if (!ctx) return { painted: false, colours: [] };
	    const { width, height } = canvas;
	    const seen = new Map();
	    for (let y = 4; y < height; y += 7) {
	      for (let x = 4; x < width; x += 7) {
	        const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
	        if (a < 200) continue;
	        const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
	        seen.set(hex, (seen.get(hex) ?? 0) + 1);
	      }
	    }
	    // A single-series bar chart on white is legitimately about six colours:
	    // background, bar, gridline, axis, label, title. Blank is one or two.
	    return {
	      painted: seen.size > 4,
	      distinct: seen.size,
	      colours: [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map((e) => e[0])
	    };
	  };

	  const samples = canvases.map(sample);
	  return {
	    chars: text.length,
	    canvasCount: canvases.length,
	    sizes: canvases.map((c) => c.width + 'x' + c.height),
	    samples,
	    errorsOnPage: (text.match(/Flint could not assemble|No rows|Could not load the charting/g) || []).length,
	    evidenceErrors: (text.match(/Error in Query|Query Error|No results/gi) || []).length,
	    titles: [...document.querySelectorAll('.flint-title')].map((n) => n.textContent.trim()),
	    audit: [...document.querySelectorAll('.flint-audit li code')].map((n) => n.textContent.trim())
	  };
	`);

	/* ------------------------------------------------------------------- checks -- */

	check('the page rendered', state.chars > 500, `${state.chars} chars`);
	check('every chart got a canvas', state.canvasCount >= 5, `${state.canvasCount} of 5 canvases`);
	check(
		'no canvas collapsed to zero width',
		state.sizes.every((s) => !s.startsWith('0x') && !s.endsWith('x0')),
		state.sizes.join(' ')
	);
	check(
		'every canvas actually painted',
		state.samples.length > 0 && state.samples.every((s) => s.painted),
		state.samples.map((s) => s.distinct).join(', ')
	);
	check('no chart reported a failure', state.errorsOnPage === 0, `${state.errorsOnPage} on page`);
	check('no Evidence query error', state.evidenceErrors === 0, `${state.evidenceErrors} on page`);
	check('titles rendered in the DOM', state.titles.length >= 5, state.titles.length + ' titles');

	// The whole point of the theme bridge: ECharts' stock hues must not survive.
	const STOCK = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272'];
	const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
	const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
	const painted = state.samples.flatMap((s) => s.colours);

	check(
		'no ECharts stock hue on any canvas',
		!STOCK.some((h) => painted.includes(h)),
		STOCK.filter((h) => painted.includes(h)).join(', ') || 'none found'
	);
	check(
		'the project palette is on the canvas',
		LIGHT.some((h) => painted.includes(h)),
		LIGHT.filter((h) => painted.includes(h)).join(', ') || 'none found'
	);
	// A light page drawing dark-palette hues means surface detection is wrong — the
	// chart is legible-ish and every contrast guarantee it was validated for is void.
	check(
		'the light page did not draw the dark palette',
		!DARK.filter((h) => !LIGHT.includes(h)).some((h) => painted.includes(h)),
		DARK.filter((h) => painted.includes(h)).join(', ') || 'none found'
	);

	// The last chart on the page is deliberately flawed, with showAudit=true.
	check(
		'the in-page audit reported the planted defects',
		state.audit.includes('unformatted-measure'),
		state.audit.join(', ') || 'nothing reported'
	);

	const crashes = page.pageErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
	check('no uncaught exception', crashes.length === 0, crashes.slice(0, 2).join(' | '));

	/* ------------------------------------------------------------------- report -- */

	failed = checks.filter(([, ok]) => !ok);
	for (const [name, ok, detail] of checks) {
		console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	}
	console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);

	if (failed.length) {
		await page.screenshot('/tmp/flint-ui-failure.png');
		console.log('screenshot: /tmp/flint-ui-failure.png');
		for (const line of page.consoleLines.slice(-15)) console.log(`  ${line}`);
	}

} finally {
	page.close();
}

process.exit(failed.length ? 1 : 0);
