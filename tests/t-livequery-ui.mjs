/**
 * LiveQuery on the management report, in a real browser.
 *
 * The claim is narrow and worth pinning down: opening an exhibit changes
 * nothing, editing it redraws that exhibit and only that one, writes are
 * refused, and Reset restores the published figure. None of that is visible to
 * a build — the SQL runs in duckdb-wasm, in the page, after hydration.
 *
 * The report is the right place to test it. Its exhibits carry accounting
 * formats, subtotals and print groups, and the whole point of wrapping rather
 * than replacing them is that none of that is lost.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 *   node tests/t-livequery-ui.mjs
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/reports/revenue-performance/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const page = await openPage(URL, { width: 1500, height: 2600 });
await page.sleep(14000); // duckdb-wasm boot, then every query on the page

/** Read one panel's state. */
const panel = (i) =>
	page.evaluate(`
    const p = [...document.querySelectorAll('.live')][${i}];
    if (!p) return { missing: true };
    return {
      title:   p.querySelector('.what')?.textContent?.trim() ?? '',
      rows:    Number((p.querySelector('.count')?.textContent ?? '').replace(/[^0-9]/g, '')),
      edited:  p.classList.contains('edited'),
      badge:   !!p.querySelector('.badge'),
      marks:   p.querySelectorAll('canvas, svg, table').length,
      error:   p.querySelector('.error')?.textContent?.trim() ?? null,
      sql:     p.querySelector('textarea')?.value ?? null
    };
  `);

const act = (i, body) =>
	page.evaluate(`
    const p = [...document.querySelectorAll('.live')][${i}];
    ${body}
    return 1;
  `);

const setSql = (i, sql) =>
	page.evaluate(`
    const p = [...document.querySelectorAll('.live')][${i}];
    const ta = p.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(sql)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  `);

const runPanel = (i) => act(i, `p.querySelector('button.primary').click();`);
const resetPanel = (i) => act(i, `[...p.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reset').click();`);

/* ------------------------------------------------------------------ layout -- */

const all = await page.evaluate(`
  const ps = [...document.querySelectorAll('.live')];
  return {
    count: ps.length,
    titles: ps.map(p => p.querySelector('.what')?.textContent?.trim() ?? ''),
    rendered: ps.filter(p => p.querySelectorAll('canvas, svg, table').length > 0).length,
    edited: ps.filter(p => p.classList.contains('edited')).length
  };
`);

check('every exhibit is wrapped', all.count >= 7, `${all.count} panels`);
check('each panel names its exhibit', all.titles.every(Boolean), all.titles.join(', '));
check('every exhibit rendered', all.rendered === all.count, `${all.rendered}/${all.count}`);
check('nothing is edited on load', all.edited === 0, `${all.edited} marked edited`);

/* ----------------------------------------------------- the SQL that ran -- */

const TREND = 1; // Exhibit 2.1 — the grain comes from a ButtonGroup
await act(TREND, `p.querySelector('.toggle').click();`);
await page.sleep(800);
const opened = await panel(TREND);

check('opening an exhibit shows its SQL', !!opened.sql, opened.sql ? `${opened.sql.length} chars` : 'empty');
check(
	'the SQL shown is the SQL that ran, with inputs resolved',
	/date_trunc\('(day|week|month)'/.test(opened.sql ?? ''),
	(opened.sql ?? '').match(/date_trunc\('[^']*'/)?.[0] ?? 'no date_trunc found'
);
check(
	'metric references are resolved, not left as ${…}',
	!/\$\{/.test(opened.sql ?? ''),
	'an unresolved ref would not run'
);
check('opening it did not change the exhibit', !opened.edited && !opened.badge);

/* ------------------------------------------------------------------- edit -- */

const before = await panel(TREND);
await setSql(
	TREND,
	"select date_trunc('month', ordered_date) as period, sum(order_amount_usd) as revenue " +
		"from dbt_semantic.orders where order_status <> 'cancelled' group by 1 order by 1"
);
await runPanel(TREND);
await page.sleep(3500);
const after = await panel(TREND);

check('editing re-runs and changes the result', after.rows !== before.rows, `${before.rows} → ${after.rows} rows`);
check('the exhibit redrew rather than disappearing', after.marks > 0, `${after.marks} marks`);
check('an edited exhibit says so', after.edited && after.badge);
check('the edit produced no error', !after.error, after.error ?? '');

// Editing one exhibit must not touch another bound to the same query.
const sibling = await panel(3); // Table 2.3, also built on `trend`
check(
	'editing one exhibit leaves the others alone',
	!sibling.edited && sibling.rows === before.rows,
	`sibling has ${sibling.rows} rows, edited=${sibling.edited}`
);

/* ------------------------------------------------------------------ guard -- */

await setSql(TREND, 'drop table dbt_semantic.orders');
await runPanel(TREND);
await page.sleep(1200);
const dropped = await panel(TREND);
check('a write statement is refused', /only read queries/i.test(dropped.error ?? ''), dropped.error ?? 'no refusal');

await setSql(TREND, "select 1 as a; select 2 as b");
await runPanel(TREND);
await page.sleep(1000);
const twoStatements = await panel(TREND);
check('a second statement is refused', /one statement/i.test(twoStatements.error ?? ''), twoStatements.error ?? 'no refusal');

// The refusals must not have disturbed the data the exhibit is showing.
check('a refused query leaves the last good result in place', twoStatements.rows === after.rows, `${twoStatements.rows} rows`);

/* --------------------------------------------------------- broken SQL -- */

await setSql(TREND, 'select nope from dbt_semantic.orders');
await runPanel(TREND);
await page.sleep(2000);
const broken = await panel(TREND);
check(
	'a broken query reports DuckDB’s own message',
	/binder error|referenced column/i.test(broken.error ?? ''),
	(broken.error ?? 'no error').split('\n')[0].slice(0, 70)
);

/* ------------------------------------------------------------------ reset -- */

await resetPanel(TREND);
await page.sleep(2000);
const restored = await panel(TREND);
check('Reset restores the published figure', restored.rows === before.rows && !restored.edited, `${restored.rows} rows, edited=${restored.edited}`);
check('Reset clears the error', !restored.error, restored.error ?? '');

/* ------------------------------------------------------------------ report -- */

const crashes = page.pageErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
check('no uncaught exception', crashes.length === 0, crashes.slice(0, 2).join(' | '));

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);

if (failed.length) {
	await page.screenshot('/tmp/livequery-failure.png');
	console.log('screenshot: /tmp/livequery-failure.png');
	for (const line of page.consoleLines.slice(-12)) console.log(`  ${line}`);
}

page.close();
process.exit(failed.length ? 1 : 0);
