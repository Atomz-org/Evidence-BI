/**
 * The Rill explore dashboard, in a real browser.
 *
 * `t-rill.mjs` proves the SQL is right. This proves the page is wired to it:
 * that a click on a leaderboard reaches every panel, that the comparison toggle
 * reaches the cards, that switching to a non-additive measure actually withdraws
 * the share column instead of merely being documented as doing so.
 *
 * The governance checks are the ones worth having here. A number that is wrong
 * fails loudly in the node tests; a *claim* that is wrong — a share shown for a
 * distinct count, a shelf aggregation that looks like it took — only fails in
 * front of a person.
 *
 * Needs a server for the built site:  node tests/static-server.mjs build 4321
 *   node tests/t-rill-ui.mjs
 */
import { openPage } from './cdp.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/rill/';

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

const page = await openPage(URL, { width: 1500, height: 3000 });
await page.sleep(15000); // duckdb-wasm boot, the view, then every panel

/** The whole dashboard's visible state, in one read. */
const read = () =>
	page.evaluate(`
    const root = document.querySelector('.rill');
    if (!root) return { missing: true };
    const cards = [...root.querySelectorAll('.card')].map(c => ({
      label: c.querySelector('.label')?.textContent?.trim() ?? '',
      value: c.querySelector('.value')?.textContent?.trim() ?? '',
      change: c.querySelector('.change')?.textContent?.trim() ?? '',
      active: c.classList.contains('active'),
      good: !!c.querySelector('.change.good'),
      bad: !!c.querySelector('.change.bad')
    }));
    const boards = [...root.querySelectorAll('.board')].map(b => ({
      title: b.querySelector('h4')?.textContent?.trim() ?? '',
      rows: [...b.querySelectorAll('li')].filter(li => !li.classList.contains('empty')).map(li => ({
        name: li.querySelector('.name')?.textContent?.trim() ?? '',
        num: li.querySelector('.num')?.textContent?.trim() ?? '',
        share: li.querySelector('.share')?.textContent?.trim() ?? null,
        trend: li.querySelector('.trend')?.textContent?.trim() ?? null,
        selected: li.classList.contains('selected')
      })),
      foot: b.querySelector('.foot')?.textContent?.trim() ?? null
    }));
    return {
      cards, boards,
      pills: [...root.querySelectorAll('.pill')].map(p => p.textContent.replace(/\\s+/g,' ').trim()),
      note: root.querySelector('.note')?.textContent?.trim() ?? null,
      window: root.querySelector('.window')?.textContent?.replace(/\\s+/g,' ').trim() ?? '',
      chartPainted: (() => {
        const c = root.querySelector('.chart canvas');
        if (!c) return false;
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
        return false;
      })(),
      sqlPanels: root.querySelectorAll('pre.sql').length,
      editable: root.querySelectorAll('.board textarea, .panel textarea').length,
      error: root.querySelector('.error')?.textContent?.trim() ?? null
    };
  `);

const clickText = (selector, text) =>
	page.evaluate(`
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(e => e.textContent.replace(/\\s+/g,' ').trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  `);

const base = await read();

/* ------------------------------------------------------------------ renders -- */

check('the dashboard rendered', !base.missing && base.cards.length >= 3, `${base.cards?.length ?? 0} cards`);
check('no error on the page', !base.error, base.error ?? '');
check('every card carries a value', base.cards?.every((c) => c.value && c.value !== '—'), JSON.stringify(base.cards?.map((c) => `${c.label} ${c.value}`)));
check('the chart painted', base.chartPainted);
check('a leaderboard per default dimension', base.boards?.length === 3, `${base.boards?.length} boards`);
check('leaderboards have values', base.boards?.every((b) => b.rows.length > 0), base.boards?.map((b) => `${b.title}:${b.rows.length}`).join(' '));

check(
	'the window says it is anchored to the data, not to today',
	/anchored to the newest row/.test(base.window) && /2026-08-04/.test(base.window),
	base.window.slice(0, 110)
);

/* --------------------------------------------------------------- comparison -- */

check('cards show a change against the previous window', base.cards?.every((c) => /[+-]/.test(c.change)), base.cards?.map((c) => c.change).join(' | '));
check(
	'a partial comparison window is flagged on the page',
	/reads high/.test(base.note ?? ''),
	base.note?.slice(0, 90) ?? 'no note'
);

const noCompare = (await page.evaluate(`
  const t = document.querySelector('.rill .toggle input');
  if (!t) return false; t.click(); return true;
`))
	? (await page.sleep(2500), await read())
	: null;
check(
	'turning the comparison off removes every delta',
	noCompare && noCompare.cards.every((c) => /no comparison/.test(c.change)),
	noCompare ? noCompare.cards.map((c) => c.change).join(' | ') : 'toggle not found'
);
check(
	'the headline values are unchanged by the comparison toggle',
	noCompare && noCompare.cards.map((c) => c.value).join() === base.cards.map((c) => c.value).join(),
	'a comparison must not move the current window'
);

await page.evaluate(`document.querySelector('.rill .toggle input').click();`);
await page.sleep(2500);

/* ------------------------------------------------------------ cross-filter -- */

const firstRegion = base.boards[0].rows[0].name;
const revenueBefore = base.cards[0].value;

await page.evaluate(`
  const li = document.querySelectorAll('.rill .board')[0].querySelectorAll('li')[0];
  li.querySelector('button.value').click();
`);
await page.sleep(3000);
const filtered = await read();

check(
	'clicking a leaderboard value filters the headline',
	filtered.cards[0].value !== revenueBefore,
	`${revenueBefore} → ${filtered.cards[0].value} after selecting ${firstRegion}`
);
check('the filter appears as a pill', filtered.pills.some((p) => p.includes(firstRegion)), filtered.pills.join(' | '));
check('the selected row is marked', filtered.boards[0].rows.some((r) => r.selected), '');
check(
	'the filtered board still shows its other values',
	filtered.boards[0].rows.length === base.boards[0].rows.length,
	`${base.boards[0].rows.length} → ${filtered.boards[0].rows.length} — a board filtered by itself would collapse to one row`
);
check(
	'another board narrows to the selection',
	filtered.boards[1].rows.length <= base.boards[1].rows.length &&
		filtered.boards[1].rows[0].num !== base.boards[1].rows[0].num,
	`${base.boards[1].title}: ${base.boards[1].rows[0].num} → ${filtered.boards[1].rows[0].num}`
);

await clickText('.rill .pill', firstRegion);
await page.sleep(2500);
const cleared = await read();
check('removing the pill restores the headline', cleared.cards[0].value === revenueBefore, `${cleared.cards[0].value} vs ${revenueBefore}`);

/* -------------------------------------------------------- governed measures -- */

const additiveShares = cleared.boards[0].rows.filter((r) => r.share).length;
check('an additive measure shows a share of total', additiveShares > 0, `${additiveShares} rows carry %`);

const switched = (await clickText('.rill .card', 'Average order value'))
	? (await page.sleep(3000), await read())
	: null;
check(
	'switching the active measure re-ranks the leaderboards',
	switched && switched.boards[0].rows[0].num !== cleared.boards[0].rows[0].num,
	switched ? `${cleared.boards[0].rows[0].num} → ${switched.boards[0].rows[0].num}` : 'card not found'
);
check(
	'a non-additive measure withdraws the share column',
	switched && switched.boards.every((b) => b.rows.every((r) => r.share === null)),
	'average order value has no meaningful share of a total'
);
check(
	'and says why, rather than just omitting it',
	switched && /does not add up across slices/.test(switched.boards[0].foot ?? ''),
	switched?.boards[0].foot ?? 'no explanation'
);

await clickText('.rill .card', 'Revenue');
await page.sleep(2500);

/* -------------------------------------------------------------- expand/TDD -- */

const expanded = (await clickText('.rill .board .ghost', 'Expand'))
	? (await page.sleep(3000), await read())
	: null;
const legend = await page.evaluate(`
  const root = document.querySelector('.rill .panel h4');
  return root ? root.textContent.replace(/\\s+/g,' ').trim() : '';
`);
check('expanding splits the chart by the dimension', /split by/i.test(legend), legend);
check('the split chart painted', expanded?.chartPainted, '');

await clickText('.rill .panel .ghost', 'Collapse');
await page.sleep(2000);

/* ----------------------------------------------------------- SQL, read-only -- */

await page.evaluate(`
  const b = [...document.querySelectorAll('.rill .panel-actions .ghost')].find(x => x.textContent.trim() === 'SQL');
  if (b) b.click();
`);
await page.sleep(700);
const withSql = await read();
const sqlText = await page.evaluate(`
  const p = document.querySelector('.rill pre.sql');
  return p ? p.textContent : '';
`);

check('a panel opens on the SQL that produced it', withSql.sqlPanels > 0 && /select/i.test(sqlText), `${sqlText.length} chars`);
check('the SQL names the governed measure expression', /sum\(order_amount_usd\)/.test(sqlText), sqlText.slice(0, 80).replace(/\s+/g, ' '));
check(
	'a governed panel is not editable',
	withSql.editable === 0,
	'a measure a reader can redefine in place is no longer governed'
);

/* -------------------------------------------------- the escape hatch, and noodle -- */

const hatch = await page.evaluate(`
  const h = document.querySelector('.rill .hatch');
  return { present: !!h, editor: !!h?.querySelector('textarea, .live') };
`);
check('the escape hatch offers an editable query', hatch.present && hatch.editor, JSON.stringify(hatch));

const noodle = await page.evaluate(`
  const text = document.body.innerText;
  const fields = [...document.querySelectorAll('[draggable="true"]')].map(e => e.textContent.trim());
  return {
    hasWorksheet: /Average order value/.test(text) && fields.length > 0,
    fieldCount: fields.length,
    hasGovernedMeasure: fields.some(f => /Average order value/i.test(f)),
    hasCancellationRate: fields.some(f => /Cancellation rate/i.test(f))
  };
`);
check('the worksheet below is built from the same metrics view', noodle.hasWorksheet, `${noodle.fieldCount} draggable fields`);
check('governed measures are draggable there', noodle.hasGovernedMeasure && noodle.hasCancellationRate, JSON.stringify(noodle));

/* ------------------------------------------------------------------ report -- */

const crashes = page.pageErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
check('no uncaught exception', crashes.length === 0, crashes.slice(0, 2).join(' | '));

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);

if (failed.length) {
	await page.screenshot('/tmp/rill-ui-failure.png');
	console.log('screenshot: /tmp/rill-ui-failure.png');
	for (const line of page.consoleLines.slice(-14)) console.log(`  ${line}`);
}

page.close();
process.exit(failed.length ? 1 : 0);
