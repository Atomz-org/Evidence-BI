/**
 * The notebook page's live screen, in a real browser.
 *
 * Everything above the fold on that page is a printout — committed cell outputs
 * from whenever the notebook last ran. The section this covers is the part that
 * is not: the two decisions that carry the analysis are controls, and the screen
 * recomputes in duckdb-wasm when they move.
 *
 * `t-screen.mjs` proves the SQL is the notebook's method. This proves the page
 * actually wires it up — that the controls reach the query, that the query
 * reaches the exhibits, and that the printout above is left alone.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 *   node tests/t-notebook-ui.mjs
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/notebooks/order-anomalies/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const page = await openPage(URL, { width: 1500, height: 2800 });
await page.sleep(14000);

/** Flagged count, days scored, and the two panels' row counts. */
const read = () =>
	page.evaluate(`
    const text = document.body.innerText;
    const panels = [...document.querySelectorAll('.live')];
    const after = text.slice(text.indexOf('Re-run the screen'));
    const num = (label) => {
      const m = after.match(new RegExp(label + '\\\\s*([\\\\d,]+)'));
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };
    return {
      flagged: num('Days flagged'),
      scored: num('Days scored'),
      flaggedRows: Number((panels[1]?.querySelector('.count')?.textContent ?? '').replace(/[^0-9]/g, '')),
      chartRows: Number((panels[0]?.querySelector('.count')?.textContent ?? '').replace(/[^0-9]/g, '')),
      panels: panels.length,
      errors: (text.match(/Error in Query|Binder Error|Dataset is empty/gi) || []).length
    };
  `);

/** Click a ButtonGroup option by its label. */
const choose = (label) =>
	page.evaluate(`
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  `);

const base = await read();

check('the live section rendered', base.panels >= 2, `${base.panels} panels`);
check('no query errors on the page', base.errors === 0, `${base.errors} error phrases`);
check('the screen scored the days it has history for', base.scored > 0, `${base.scored} days scored`);
check('the default screen flags something', base.flagged > 0, `${base.flagged} flagged at |z| >= 3.5`);
check(
	'the flagged table matches the headline count',
	base.flaggedRows === base.flagged,
	`table ${base.flaggedRows} vs headline ${base.flagged}`
);

// The printout above must survive: the notebook's committed figure is still there.
const printout = await page.evaluate(`
  return {
    images: document.querySelectorAll('img').length,
    pandasTable: /order_date/.test(document.body.innerText),
    stillSaysPython: /WINDOW = 28/.test(document.body.innerText)
  };
`);
check('the notebook’s own outputs are untouched', printout.images > 0 && printout.stillSaysPython, `${printout.images} figures`);

/* ------------------------------------------------------------- the controls -- */

const loosened = (await choose('2.5')) ? (await page.sleep(3200), await read()) : null;
check(
	'lowering the threshold flags more days',
	loosened && loosened.flagged > base.flagged,
	loosened ? `${base.flagged} at 3.5 → ${loosened.flagged} at 2.5` : 'threshold control not found'
);
check(
	'the flagged table follows the threshold',
	loosened && loosened.flaggedRows === loosened.flagged,
	loosened ? `${loosened.flaggedRows} rows` : ''
);

const widened = (await choose('56')) ? (await page.sleep(3600), await read()) : null;
check(
	'the window control changes the screen',
	widened && widened.flagged !== loosened.flagged,
	widened ? `${loosened?.flagged} at 28d → ${widened.flagged} at 56d` : 'window control not found'
);

// min_periods is fixed at 14 in the notebook, so the scored count should not
// move with the window — if it does, the SQL has drifted from the method.
check(
	'widening the window does not change how many days are scored',
	widened && widened.scored === base.scored,
	`${base.scored} → ${widened?.scored}`
);

// `widened` was read at threshold 2.5; this raises it back to 3.5 at the same
// window. A stricter threshold cannot flag more days — if it does, the filter
// and the score have come apart.
const stricter = (await choose('3.5')) ? (await page.sleep(3200), await read()) : null;
check(
	'raising the threshold back never flags more days',
	stricter && widened && stricter.flagged <= widened.flagged,
	stricter && widened ? `${widened.flagged} at |z|>=2.5 → ${stricter.flagged} at |z|>=3.5, both at 56d` : ''
);

/* ------------------------------------------------------------------ report -- */

const crashes = page.pageErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
check('no uncaught exception', crashes.length === 0, crashes.slice(0, 2).join(' | '));

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);

if (failed.length) {
	await page.screenshot('/tmp/notebook-ui-failure.png');
	console.log('screenshot: /tmp/notebook-ui-failure.png');
	for (const line of page.consoleLines.slice(-12)) console.log(`  ${line}`);
}

page.close();
process.exit(failed.length ? 1 : 0);
