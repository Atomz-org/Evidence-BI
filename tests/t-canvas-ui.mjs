/**
 * The unified board, in a real browser.
 *
 * `t-canvas.mjs` proves each engine is right on its own. The claim this page
 * makes is different and can only be checked here: that the five tools are no
 * longer five tools. One click on a leaderboard has to move the KPI row, both
 * charts, the pivot, the table and the notebook cell — because they are reading
 * one scan of one view. A board where four of the six follow and one does not
 * is worse than five separate pages, since nothing announces the disagreement.
 *
 * So the central test is a single click, and a count of what moved.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 *   node tests/t-canvas-ui.mjs
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/canvas/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const page = await openPage(URL, { width: 1500, height: 3000 });
await page.sleep(20000); // duckdb-wasm, the view, then every tile

/** One read of everything the board is showing. */
const read = () =>
	page.evaluate(`
    const c = document.querySelector('.canvas');
    if (!c) return { missing: true };
    const text = (el) => el?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    return {
      kpis: [...c.querySelectorAll('.kpi')].map(k => ({
        label: text(k.querySelector('.label')),
        value: text(k.querySelector('.value')),
        change: text(k.querySelector('.change')),
        good: !!k.querySelector('.change.good'),
        bad: !!k.querySelector('.change.bad')
      })),
      charts: c.querySelectorAll('canvas').length,
      painted: [...c.querySelectorAll('canvas')].filter(cv => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, Math.min(cv.height, 300)).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
        return false;
      }).length,
      boards: [...c.querySelectorAll('ul.board')].map(b => ({
        rows: b.querySelectorAll('li').length,
        first: text(b.querySelector('.name')),
        firstNum: text(b.querySelector('.num')),
        names: [...b.querySelectorAll('.name')].map(text)
      })),
      pivot: {
        rows: c.querySelectorAll('table.pivot tbody tr').length,
        cols: c.querySelectorAll('table.pivot thead tr:first-child th').length,
        // Cells per body row, which is column-keys x measures — the first header
        // row uses colspan, so its th count is blind to the measure list.
        cells: c.querySelectorAll('table.pivot tbody tr:first-child td').length,
        totalRows: c.querySelectorAll('table.pivot tbody tr.total').length,
        firstCell: text(c.querySelector('table.pivot tbody td')),
        grand: text(c.querySelector('table.pivot tbody tr.total td:last-child'))
      },
      table: {
        rows: c.querySelectorAll('table.plain tbody tr').length,
        headers: [...c.querySelectorAll('table.plain thead th')].map(text)
      },
      notebook: {
        sql: c.querySelector('.notebook textarea')?.value ?? '',
        rows: c.querySelectorAll('.notebook tbody tr').length,
        badged: !!c.querySelector('.notebook .live.edited')
      },
      pills: [...c.querySelectorAll('.pill')].map(text),
      editableGoverned: c.querySelectorAll('.panel:not(.notebook) textarea').length,
      error: text(c.querySelector('.error')) || null
    };
  `);

const base = await read();

/* ------------------------------------------------------------- everything -- */

check('the board rendered', !base.missing && base.kpis.length === 4, `${base.kpis?.length ?? 0} KPIs`);
check('no error on the board', !base.error, base.error ?? '');
check('every KPI carries a value', base.kpis.every((k) => k.value && k.value !== '—'), base.kpis.map((k) => `${k.label} ${k.value}`).join(' | '));
check('all three charts painted', base.charts === 3 && base.painted === 3, `${base.painted}/${base.charts}`);
check('both leaderboards populated', base.boards.length === 2 && base.boards.every((b) => b.rows > 0), base.boards.map((b) => b.rows).join('/'));
check('the pivot has cells and a total row', base.pivot.rows > 1 && base.pivot.totalRows === 1, JSON.stringify(base.pivot));
check('the table uses the metrics view labels, not column names', base.table.headers.includes('Average order value'), base.table.headers.join(', '));
check('the notebook cell ran itself', base.notebook.rows > 0, `${base.notebook.rows} rows`);

check(
	'lower_is_better flips which direction reads as good',
	base.kpis.find((k) => /cancellation/i.test(k.label))?.bad === true,
	`cancellation rate change: ${base.kpis.find((k) => /cancellation/i.test(k.label))?.change}`
);

/* ------------------------------------------------- governed vs not governed -- */

check(
	'no governed tile is editable',
	base.editableGoverned === 0,
	`${base.editableGoverned} editable panels outside the notebook cell`
);
check(
	'the notebook cell inherits the board window',
	/ordered_at" >= timestamp/.test(base.notebook.sql) && /rill_orders_metrics/.test(base.notebook.sql),
	base.notebook.sql.slice(0, 60).replace(/\s+/g, ' ')
);
check(
	'the notebook cell is not badged as edited before anyone edits it',
	!base.notebook.badged,
	'auto-running a detached panel is its published state, not the reader’s change'
);

/* -------------------------------------------------- the one click that matters -- */

const clicked = await page.evaluate(`
  const li = document.querySelectorAll('.canvas ul.board')[0].querySelectorAll('li')[0];
  const name = li.querySelector('.name').textContent.trim();
  li.querySelector('button.value').click();
  return name;
`);
await page.sleep(4000);
const after = await read();

check('the filter appears as a pill', after.pills.some((p) => p.includes(clicked)), after.pills.join(' | '));

const moved = {
	kpi: after.kpis[0].value !== base.kpis[0].value,
	pivot: after.pivot.rows !== base.pivot.rows || after.pivot.grand !== base.pivot.grand,
	table: after.table.rows !== base.table.rows,
	// Not the leading value: the top country is entirely inside the top region,
	// so its revenue is identical either way. What must change is which countries
	// are on the board at all.
	otherBoard: after.boards[1].names.length !== base.boards[1].names.length,
	notebook: after.notebook.sql !== base.notebook.sql
};
check(
	`one click on ${clicked} moved the whole board`,
	Object.values(moved).every(Boolean),
	Object.entries(moved).map(([k, v]) => `${k}:${v ? 'moved' : 'STUCK'}`).join(' ')
);
check(
	'the leaderboard you clicked keeps its other values',
	after.boards[0].rows === base.boards[0].rows,
	`${base.boards[0].rows} → ${after.boards[0].rows} — a board filtered by itself would collapse`
);
check(
	'the notebook cell picked up the filter, not just the window',
	// It has to be inside an IN list in the scan, not merely somewhere in the
	// text — a dimension whose name contained the value would pass a substring test.
	new RegExp(`in \\([^)]*'${clicked}'`, 'i').test(after.notebook.sql),
	after.notebook.sql.split('\n').find((l) => l.includes(clicked))?.trim() ?? 'filter absent from the scan'
);

await page.evaluate(`document.querySelector('.canvas .clear').click();`);
await page.sleep(3500);
const cleared = await read();
check('clearing restores every tile', cleared.kpis[0].value === base.kpis[0].value && cleared.pivot.grand === base.pivot.grand, `${cleared.kpis[0].value} vs ${base.kpis[0].value}`);

/* ------------------------------------------------------------ pivot shelves -- */

const pivoted = await page.evaluate(`
  // Move "Country" onto the columns axis.
  const chips = [...document.querySelectorAll('.canvas .shelves .chip')];
  const country = chips.find(c => c.textContent.includes('Country'));
  if (!country) return false;
  country.querySelectorAll('button')[1].click();
  return true;
`);
await page.sleep(4000);
const withCountry = await read();
check(
	'a dimension can be moved onto the pivot’s column axis',
	pivoted && withCountry.pivot.cols > cleared.pivot.cols,
	`${cleared.pivot.cols} → ${withCountry.pivot.cols} header cells`
);

await page.evaluate(`
  const chips = [...document.querySelectorAll('.canvas .shelves .chip')];
  chips.find(c => c.textContent.includes('Country'))?.querySelectorAll('button')[1].click();
`);
await page.sleep(3500);

const droppedMeasure = await page.evaluate(`
  const chip = [...document.querySelectorAll('.canvas .shelves .chip.measure')]
    .find(c => c.textContent.trim() === 'Average order value');
  if (!chip) return false;
  chip.click();
  return true;
`);
await page.sleep(3500);
const oneMeasure = await read();
check(
	'a measure can be taken off the pivot',
	droppedMeasure && oneMeasure.pivot.cells < cleared.pivot.cells,
	`${cleared.pivot.cells} → ${oneMeasure.pivot.cells} cells per row`
);

/* ----------------------------------------------------------------- windows -- */

const shortened = await page.evaluate(`
  const s = document.querySelector('.canvas select');
  s.value = 'P7D';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
`);
await page.sleep(4500);
const week = await read();
check(
	'changing the window moves every number',
	shortened && week.kpis[0].value !== cleared.kpis[0].value,
	`${cleared.kpis[0].value} (4 weeks) → ${week.kpis[0].value} (7 days)`
);
check(
	'the notebook cell follows the window too',
	week.notebook.sql !== cleared.notebook.sql,
	'its scan is the board’s scan'
);

/* ------------------------------------------------------------------ report -- */

// Flint audits every option it builds and logs what it finds. A warning here is
// a real defect in a chart on this board, so the console is part of the test.
const flintWarnings = [...new Set(page.consoleLines.filter((l) => /FlintChart:/.test(l)))];
check('flint reports nothing wrong with any chart', flintWarnings.length === 0, flintWarnings.slice(0, 3).join(' | '));

const crashes = page.pageErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
check('no uncaught exception', crashes.length === 0, crashes.slice(0, 2).join(' | '));

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);

if (failed.length) {
	await page.screenshot('/tmp/canvas-ui-failure.png');
	console.log('screenshot: /tmp/canvas-ui-failure.png');
	for (const line of page.consoleLines.slice(-14)) console.log(`  ${line}`);
}

page.close();
process.exit(failed.length ? 1 : 0);
