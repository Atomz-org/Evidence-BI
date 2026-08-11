/**
 * Drive the noodle surface the way a person would, in a real browser, and check
 * the state it lands in. Drag-and-drop is dispatched as real DragEvents so the
 * component's own handlers run.
 */
import { openPage } from './cdp.mjs';

const page = await openPage('http://127.0.0.1:4321/noodle/', { width: 1600, height: 1300 });
const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

await page.sleep(11000);

/** Dispatch a drag from a field row onto a shelf. */
const DRAG = `
  window.__drag = (fieldText, shelfIndex) => {
    const field = [...document.querySelectorAll('.noodle .field')]
      .find(el => el.textContent.replace(/\\s+/g,' ').trim() === fieldText);
    const shelves = document.querySelectorAll('.noodle .shelf');
    const shelf = shelves[shelfIndex];
    if (!field || !shelf) return 'missing:' + (!field ? 'field' : 'shelf');
    const dt = new DataTransfer();
    field.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    shelf.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    shelf.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'ok';
  };
  return 'installed';
`;
await page.evaluate(DRAG);

const state = () =>
	page.evaluate(`
    const q = (s) => [...document.querySelectorAll('.noodle ' + s)];
    return {
      pills: q('.pill .pill-label').map(e => e.textContent.trim()),
      hints: q('.shelves .drop-hint').length,
      activeMark: q('.mark.active').map(e => e.textContent.trim())[0] ?? null,
      reason: q('.reason').map(e => e.textContent.trim())[0] ?? null,
      canvases: q('canvas').length,
      rowCount: q('.foot .muted').map(e => e.textContent.trim())[0] ?? null,
      filters: q('.filter').map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
      warnings: q('.warning').map(e => e.textContent.trim()),
      tableHeaders: q('table th').map(e => e.textContent.trim())
    };
  `);

/* ------------------------------------------------- initial state ---------- */
let s = await state();
check('initial pills from `initial` prop', s.pills.length === 2, JSON.stringify(s.pills));
check('no stale drop hint beside a filled shelf', s.hints === 0, `${s.hints} hints`);
check('date field picks Line', s.activeMark === 'Line', s.activeMark);
check('Show Me explains the choice', (s.reason ?? '').includes('change over time'), s.reason);
check('chart drew', s.canvases === 1);

/* ------------------------------------- drag Region onto Color ------------- */
// Shelf order in the DOM: 0 = Columns, 1 = Rows, then Color, Size, Label.
const dragResult = await page.evaluate(`return window.__drag('Abc Region 4', 2) ?? 'none';`);
check('drag dispatched onto Color', dragResult === 'ok', dragResult);
await page.sleep(2500);

s = await state();
check('colour pill landed', s.pills.some((p) => p.includes('Region')), JSON.stringify(s.pills));
check('chart still drawn after colour', s.canvases === 1);

/* --------------------------------------- switch the mark to a table ------- */
await page.evaluate(`
  const table = [...document.querySelectorAll('.noodle .mark')].find(b => b.textContent.trim() === 'Table');
  table?.click();
  return 'clicked';
`);
await page.sleep(1800);
s = await state();
check('mark switched to Table', s.activeMark === 'Table', s.activeMark);
check('table rendered with headers', s.tableHeaders.length >= 3, JSON.stringify(s.tableHeaders));

/* --------------------------------- aggregation menu on a measure pill ----- */
await page.evaluate(`
  const pill = [...document.querySelectorAll('.noodle .pill .pill-label')]
    .find(e => e.textContent.includes('Sum of Order Amount'));
  pill?.click();
  return 'opened';
`);
await page.sleep(700);
const menuItems = await page.evaluate(
	`return [...document.querySelectorAll('.noodle .menu .menu-item')].map(e => e.textContent.trim());`
);
check('pill menu offers aggregations', menuItems.includes('Average'), JSON.stringify(menuItems.slice(0, 6)));
check('pill menu offers table calculations', menuItems.includes('Running total'), JSON.stringify(menuItems.slice(-7)));

await page.evaluate(`
  const item = [...document.querySelectorAll('.noodle .menu .menu-item')].find(e => e.textContent.trim() === 'Average');
  item?.click();
  return 'avg';
`);
await page.sleep(2000);
s = await state();
check('aggregation changed the pill', s.pills.some((p) => p.startsWith('Average of')), JSON.stringify(s.pills));

/* ------------------------------------------------ export as markdown ------ */
await page.evaluate(`
  [...document.querySelectorAll('.noodle .ghost')].find(b => b.textContent.includes('source'))?.click();
  return 'shown';
`);
await page.sleep(900);
const exported = await page.evaluate(`return document.querySelector('.noodle .sql')?.textContent ?? '';`);
check('export contains a sql block', exported.includes('```sql explored'), exported.slice(0, 80));
check('export contains an Evidence component', /<(DataTable|BarChart|LineChart)/.test(exported), exported.slice(-160));
check('export carries the LOD-free aggregate', exported.includes('avg('), exported.slice(0, 400));

await page.screenshot('noodle3.png');

console.log(page.pageErrors.length ? `PAGE ERRORS:\n${page.pageErrors.slice(0, 4).join('\n')}` : 'no page errors');

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
page.close();
process.exit(failed ? 1 : 0);
