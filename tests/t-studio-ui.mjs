/**
 * The Studio, in a real browser.
 *
 * Everything on this page happens client-side — catalog introspection, four
 * queries, four chart renders, and then a cross-filter that re-runs three of
 * them. A build that succeeds proves none of it.
 *
 * The load-bearing assertion is the cross-filter. Clicking a bar has to change
 * the *other* views' numbers, and clicking it again has to put them back. A chip
 * appearing in the filter bar would pass a test while the tiles sat unchanged
 * behind it, so the check reads the headline figure before and after.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/studio/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await openPage(URL, { width: 1600, height: 1600 });
await sleep(2000);

// Saved dashboards live in localStorage and the CDP profile is reused between
// runs, so a leftover from last time would be opened instead of the auto-build.
await page.evaluate(`localStorage.clear(); return true;`);
await page.evaluate(`location.reload(); return true;`).catch(() => {});
await sleep(9000); // duckdb-wasm, catalog introspection, four tile queries

/** A compact snapshot of what is on screen. */
const snapshot = () =>
	page.evaluate(`
	  const q = (s) => [...document.querySelectorAll(s)];
	  const text = document.body.innerText;
	  return {
	    tiles:     q('.tile').length,
	    canvases:  q('.tile canvas').length,
	    headline:  document.querySelector('.bv-value')?.textContent?.trim() ?? null,
	    chips:     q('.chip').map((c) => c.textContent.trim().replace(/\\s+/g, ' ')),
	    badges:    q('.badge').length,
	    titles:    q('.tile-title').map((i) => i.value),
	    errors:    (text.match(/could not run|Error in Query/gi) || []).length,
	    bad:       (text.match(/NaN|\\[object Object\\]|undefined/g) || []).length,
	    notes:     q('.tile-note').map((n) => n.textContent.trim()).filter(Boolean)
	  };
	`);

const before = await snapshot();

check('the studio mounted with an auto-built dashboard', before.tiles >= 4, `${before.tiles} tiles`);
check('its charts drew to canvas', before.canvases >= 2, `${before.canvases} canvases`);
check(
	'the auto-build chose a figure, a trend, a breakdown and a table',
	before.titles.length === 4 &&
		/^Total /.test(before.titles[0]) &&
		/ over time$/.test(before.titles[1]) &&
		/ by /.test(before.titles[2]),
	before.titles.join(' · ')
);
// The first numeric column in a table is rarely the number the table is about.
check(
	'the headline is a money measure, not whatever column came first',
	/USD|Amount|Revenue|Sales/i.test(before.titles[0] ?? ''),
	before.titles[0]
);
check('a headline figure is present', !!before.headline, `headline = ${before.headline}`);

// A width the auto-build can produce but the picker cannot offer is a layout
// that silently rearranges itself the first time the dashboard is reopened —
// deserialize falls back to half-width for anything off the list.
const widths = await page.evaluate(`
  return [...document.querySelectorAll('.tile')].map((t) => {
    const select = t.querySelector('select');
    return { value: select?.value ?? null, matched: !!select && select.selectedIndex >= 0 };
  });
`);
check(
	'every tile width the auto-build produced is one the model accepts',
	widths.length > 0 && widths.every((w) => w.matched),
	widths.map((w) => w.value || '(unmatched)').join(', ')
);

// The tile toolbar is a fixed width and the title is not, so on the narrowest
// tile the title is the thing that gets crushed — "Total Order Amount USD"
// rendered as "Tota" and still passed every other assertion here.
const titleRoom = await page.evaluate(`
  return [...document.querySelectorAll('.tile-title')].map((i) => Math.round(i.clientWidth));
`);
check(
	'no tile title is crushed by its toolbar',
	titleRoom.length > 0 && titleRoom.every((w) => w >= 100),
	`${titleRoom.join('px, ')}px`
);
check('no tile failed to run', before.errors === 0, `${before.errors} errors`);
check('nothing leaked NaN / undefined / [object Object]', before.bad === 0, `${before.bad} found`);

/* ------------------------------------------------------------ cross-filter -- */

/**
 * Click a bar in the breakdown view.
 *
 * ECharts only raises a click when the pointer lands on a mark, and the mark
 * positions depend on the data, so the x is swept until something responds.
 * Clicking low in the plot keeps the pointer inside a bar whatever its height.
 */
const box = await page.evaluate(`
  const tiles = [...document.querySelectorAll('.tile')];
  const tile = tiles.find((t) => / by /.test(t.querySelector('.tile-title')?.value ?? ''));
  const canvas = tile?.querySelector('canvas');
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
`);
check('the breakdown view has a clickable canvas', !!box, box ? `${Math.round(box.w)}×${Math.round(box.h)}` : 'none');

let afterClick = before;
let clickedAt = null;

if (box) {
	for (let i = 1; i <= 14 && !clickedAt; i++) {
		const x = Math.round(box.x + (box.w * i) / 15);
		const y = Math.round(box.y + box.h * 0.8);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await page.send('Input.dispatchMouseEvent', {
				type,
				x,
				y,
				button: 'left',
				clickCount: 1,
				buttons: type === 'mousePressed' ? 1 : 0
			});
		}
		await sleep(700);
		const now = await snapshot();
		if (now.chips.length) {
			clickedAt = { x, y };
			afterClick = now;
		}
	}
}

check(
	'clicking a mark raises a cross-filter',
	afterClick.chips.length === 1,
	afterClick.chips.join(' | ') || 'no chip appeared'
);
check(
	'the view that raised it is marked as the source',
	afterClick.badges === 1,
	`${afterClick.badges} badges`
);
check(
	'the other views actually re-ran — the headline moved',
	!!afterClick.headline && afterClick.headline !== before.headline,
	`${before.headline} → ${afterClick.headline}`
);

// Filtering to one category cannot produce more revenue than the whole.
// "$1,183" and "1.2M" both have to parse — dropping the thousands separator is
// how a passing comparison ends up being 102 < 1.
const numeric = (s) => {
	const m = String(s ?? '')
		.replace(/,/g, '')
		.match(/([\d.]+)\s*([KMB])?/);
	if (!m) return NaN;
	return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1);
};
check(
	'the filtered headline is smaller than the unfiltered one',
	numeric(afterClick.headline) < numeric(before.headline),
	`${numeric(afterClick.headline)} < ${numeric(before.headline)}`
);

// Clicking the same mark again is the way back.
if (clickedAt) {
	for (const type of ['mousePressed', 'mouseReleased']) {
		await page.send('Input.dispatchMouseEvent', {
			type,
			x: clickedAt.x,
			y: clickedAt.y,
			button: 'left',
			clickCount: 1,
			buttons: type === 'mousePressed' ? 1 : 0
		});
	}
	await sleep(1500);
}
const cleared = await snapshot();
check(
	'clicking the same mark again restores the page',
	cleared.chips.length === 0 && cleared.headline === before.headline,
	`${cleared.chips.length} chips, headline ${cleared.headline}`
);

/* ----------------------------------------------------------- page filters -- */

await page.evaluate(`
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ Filter')?.click();
  return true;
`);
await sleep(500);
await page.evaluate(`document.querySelector('.picker-item')?.click(); return true;`);
await sleep(2500);

const picker = await page.evaluate(`
  const boxes = [...document.querySelectorAll('.picker-check input')];
  boxes[0]?.click();
  return { values: boxes.length, field: document.querySelector('.picker-item.on')?.textContent?.trim() ?? null };
`);
check('the slicer loaded a field’s values', picker.values > 0, `${picker.values} values of ${picker.field}`);

await sleep(300);
await page.evaluate(`
  [...document.querySelectorAll('.drawer button')].find((b) => b.textContent.trim().startsWith('Apply'))?.click();
  return true;
`);
await sleep(3000);

const filtered = await snapshot();
check(
	'a page filter applies to the whole page',
	filtered.chips.length === 1 && filtered.headline !== before.headline,
	`${filtered.chips.join(' | ')} · headline ${before.headline} → ${filtered.headline}`
);

/* --------------------------------------------------------------- publish -- */

await page.evaluate(`
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Publish as code')?.click();
  return true;
`);
await sleep(1200);

const md = await page.evaluate(`return document.querySelector('.code')?.textContent ?? '';`);
check(
	'publishing emits a complete Evidence page',
	md.startsWith('---\ntitle:') && (md.match(/```sql /g) ?? []).length >= 4 && /<Grid cols=/.test(md),
	`${md.length} chars, ${(md.match(/```sql /g) ?? []).length} queries`
);
check(
	'the page filter is published as a real input, not a frozen value',
	/<Dropdown name=\w+ data=\{\w+_options\}/.test(md) && /\$\{inputs\./.test(md),
	md.match(/<Dropdown[^>]*>/)?.[0] ?? 'no Dropdown emitted'
);
check('no sentinel leaked into the published page', !md.includes('__evidence_input_'));

await page.evaluate(`
  [...document.querySelectorAll('.drawer button')].find((b) => b.textContent.trim() === 'Close')?.click();
  return true;
`);
await sleep(400);

/* ------------------------------------------------------- present and save -- */

await page.evaluate(`
  [...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.trim() === 'Present')?.click();
  return true;
`);
await sleep(900);
// The line present mode draws is authoring versus operating, not chrome versus
// no chrome: structural editing goes, and every way of filtering stays, because
// operating the filters is what a finished dashboard is *for*.
const presenting = await page.evaluate(`
  const labelled = (t) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === t);
  return {
    tools:     document.querySelectorAll('.tile-tools').length,
    titleInputs: document.querySelectorAll('.tile-title, .title-input, .subtitle-input').length,
    addView:   labelled('+ View') || labelled('Auto-build'),
    addFilter: labelled('+ Filter'),
    chips:     document.querySelectorAll('.chip').length,
    canvases:  document.querySelectorAll('.tile canvas').length
  };
`);
check(
	'present mode drops structural editing',
	presenting.tools === 0 && presenting.titleInputs === 0 && !presenting.addView,
	`${presenting.tools} toolbars, ${presenting.titleInputs} editable titles, add-view ${presenting.addView}`
);
check(
	'present mode keeps the views and every way of filtering them',
	presenting.canvases >= 2 && presenting.chips === 1 && presenting.addFilter,
	`${presenting.canvases} canvases, ${presenting.chips} chips, slicer picker ${presenting.addFilter}`
);

await page.evaluate(`
  [...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.trim() === 'Edit')?.click();
  return true;
`);
await sleep(400);

// Save, damage the dashboard, then reopen it. Pill keys are minted by a counter
// that restarts with the page, so a reopened tile carrying an old key alongside
// a freshly created one is how "delete this pill" deletes two.
await page.evaluate(`
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save')?.click();
  return true;
`);
await sleep(400);
await page.evaluate(`
  document.querySelector('.tile .icon.danger')?.click();
  return true;
`);
await sleep(600);
const damaged = await page.evaluate(`return document.querySelectorAll('.tile').length;`);

const reopened = await page.evaluate(`
  const select = [...document.querySelectorAll('select')].find((s) => s.options[0]?.textContent === 'Open…');
  const option = [...(select?.options ?? [])].find((o) => o.value);
  if (!select || !option) return null;
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return option.value;
`);
await sleep(5000);
const restored = await snapshot();
check(
	'a saved dashboard reopens complete, and its views re-run',
	reopened !== null && damaged === 3 && restored.tiles === 4 && restored.canvases >= 2 && restored.errors === 0,
	`saved as “${reopened}”, ${damaged} tiles after deleting one, ${restored.tiles} after reopening`
);
check(
	'the reopened dashboard keeps its filter and its numbers',
	restored.chips.length === 1 && restored.headline === filtered.headline,
	`${restored.chips.join(' | ')} · headline ${restored.headline}`
);

/* ------------------------------------------------------------ tile editor -- */

// The drawer keeps the grid behind it live, which means a statement that writes
// the dashboard runs while the editor is open. Written the obvious way that
// statement re-dirties its own dependency and spins forever, and Svelte 4 has no
// iteration cap to break out — the tab just stops answering. So the assertion
// that matters is not what the drawer renders but that the page is still there
// afterwards: the evaluate below cannot return from a locked-up renderer.
await page.evaluate(`
  [...document.querySelectorAll('.tile-tools .icon')].find((b) => b.title === 'Edit')?.click();
  return true;
`);
await sleep(1200);

const editing = await page.evaluate(`
  return {
    drawer: !!document.querySelector('.drawer, .editor'),
    heading: [...document.querySelectorAll('strong')].some((s) => /^Editing/.test(s.textContent)),
    tiles:   document.querySelectorAll('.tile').length
  };
`);
check(
	'opening the tile editor does not lock the page',
	editing !== null && editing.tiles >= 1,
	`${editing?.tiles ?? 0} tiles still rendered · drawer ${editing?.drawer} · heading ${editing?.heading}`
);

// Close it again so the modes below start from the grid, not the drawer.
await page.evaluate(`
  [...document.querySelectorAll('button')].find((b) => /^(Done|Close|×)$/.test(b.textContent.trim()))?.click();
  return true;
`);
await sleep(500);

/* ------------------------------------------------------------ report mode -- */

// Captured before the switch: the dashboard grid is the layout most of the page
// is spent in, and the report view would be the only thing on record otherwise.
await page.screenshot('/tmp/studio-dashboard.png');

await page.evaluate(`
  [...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.trim() === 'Report')?.click();
  return true;
`);
await sleep(2500);

const asReport = await page.evaluate(`
  const rows = [...document.querySelectorAll('.row')];
  return {
    perRow: rows.map((r) => r.querySelectorAll('.tile').length),
    narrow: document.querySelector('.studio')?.classList.contains('report') ?? false,
    canvases: document.querySelectorAll('.tile canvas').length
  };
`);
check(
	'report mode stacks one exhibit per row and keeps the charts',
	asReport.narrow && asReport.perRow.every((n) => n === 1) && asReport.canvases >= 2,
	`rows of ${asReport.perRow.join(',')} · ${asReport.canvases} canvases`
);

/* ------------------------------------------------------------------ done -- */

await page.screenshot('/tmp/studio.png');

const errors = page.pageErrors.filter((e) => !/favicon|404|ResizeObserver/i.test(e));
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));

page.close();

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed   (screenshot /tmp/studio.png)`);
process.exit(failed ? 1 : 0);
