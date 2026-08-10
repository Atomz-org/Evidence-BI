/**
 * The pivot — rows × columns × measures, with totals that are computed.
 *
 * Cube's pivot and Rill's are the same shape and rest on the same trap: the
 * totals. Given a grid of average order value by region and status, the total
 * row is *not* the sum of the cells and it is not their mean either. It is the
 * measure's own expression evaluated over the union of those rows — a different
 * query, not an arithmetic step. The same is true of any distinct count: one
 * customer who ordered from two regions is counted once in the total and twice
 * across the cells, so the cells exceed their own total and nothing warns you.
 *
 * Adding a column of numbers is so obviously right that the mistake survives
 * review. So this file never adds anything. Every cell, every row total, every
 * column total and the grand total come from one query using GROUPING SETS, and
 * each is the measure expression evaluated over exactly the rows it describes.
 *
 *     group by grouping sets ((region, status), (region), (status), ())
 *                              └ cells        └ row     └ column   └ grand
 *
 * One pass, one scan, four grains, no arithmetic. `grouping()` marks which
 * columns were rolled up so the shaping below can tell a total from a cell
 * whose value happens to be null.
 *
 * What is deliberately not emitted: intermediate subtotals for a partial row
 * prefix. With rows `[region, order_size]` you get cells, a total per region ×
 * nothing, and the grand total — not a subtotal per region across sizes. Adding
 * them is a longer grouping-set list; leaving them out keeps the grid readable
 * and is stated rather than discovered.
 */

import { ident } from '../noodle/engine/sql.js';
import { dimensionRef, scanCte } from '../rill/engine/metrics.js';

/**
 * Marks a roll-up in a key path.
 *
 * Written as an explicit escape rather than as the character itself. The
 * sentinel has to be a string no dimension value can equal, and every readable
 * candidate ("Total", "*", "—") is a value some column somewhere legitimately
 * holds. A NUL cannot reach here from a DuckDB VARCHAR, so it is the one safe
 * choice — but a raw NUL byte sitting invisibly in a source file is its own
 * hazard, and some tooling will treat such a file as binary.
 */
export const TOTAL = '\u0000total';

const find = (list, name) => list.find((f) => f.name === name);

/**
 * Build the pivot query.
 *
 * @param {object} metricsView
 * @param {object} args
 * @param {string[]} args.rows dimension names down the side
 * @param {string[]} args.columns dimension names across the top
 * @param {string[]} args.measures
 * @param {object} args.range
 * @param {object} args.filters
 * @param {boolean} [args.totals] include the roll-ups
 * @returns {string|null}
 */
export const pivotSql = (metricsView, { rows, columns, measures, range, filters, totals = true }) => {
	const rowDims = rows.map((n) => find(metricsView.dimensions, n)).filter(Boolean);
	const colDims = columns.map((n) => find(metricsView.dimensions, n)).filter(Boolean);
	const measureDefs = measures.map((n) => find(metricsView.measures, n)).filter(Boolean);
	if (!measureDefs.length) return null;

	const all = [...rowDims, ...colDims];
	const select = all.map((d) => `${dimensionRef(d)} as ${ident(d.name)}`);
	const flags = all.map((d) => `grouping(${dimensionRef(d)}) as ${ident(`_g_${d.name}`)}`);

	const list = (dims) => (dims.length ? `(${dims.map((d) => dimensionRef(d)).join(', ')})` : '()');
	const sets = totals
		? [...new Set([list(all), list(rowDims), list(colDims), '()'])]
		: [list(all)];

	return (
		`with ${scanCte(metricsView, { range, filters, includeComparison: false })}\n` +
		`select ${[...select, ...flags, ...measureDefs.map((m) => `${m.expression} as ${ident(m.name)}`)].join(', ')}\n` +
		`from scan\n` +
		`group by grouping sets (${sets.join(', ')})\n` +
		`order by ${all.map((d) => `${ident(`_g_${d.name}`)}, ${ident(d.name)} nulls last`).join(', ')}`
	);
};

/**
 * Turn the flat result into a grid.
 *
 * @returns {{
 *   rowKeys: string[][], colKeys: string[][],
 *   cell: (rowKey: string[], colKey: string[], measure: string) => number|null,
 *   rowLabels: string[], colLabels: string[]
 * }}
 */
export const shapePivot = (result, { rows, columns, measures, totals = true }) => {
	const key = (row, dims) =>
		dims.map((d) => (row[`_g_${d}`] === 1 || row[`_g_${d}`] === true ? TOTAL : String(row[d] ?? '—')));

	const cells = new Map();
	const rowKeys = [];
	const colKeys = [];
	const seenRow = new Set();
	const seenCol = new Set();

	for (const row of result ?? []) {
		const r = key(row, rows);
		const c = key(row, columns);
		const rk = r.join('');
		const ck = c.join('');

		if (!seenRow.has(rk)) {
			seenRow.add(rk);
			rowKeys.push(r);
		}
		if (!seenCol.has(ck)) {
			seenCol.add(ck);
			colKeys.push(c);
		}
		for (const measure of measures) cells.set(`${rk}${ck}${measure}`, row[measure] ?? null);
	}

	// Totals last, and only if they were asked for. A totals row that arrived in
	// the middle of the grid because the sort put a NULL there reads as data.
	const isTotal = (k) => k.every((part) => part === TOTAL);
	const partial = (k) => k.some((part) => part === TOTAL);
	const order = (keys) =>
		totals
			? [...keys.filter((k) => !partial(k)), ...keys.filter((k) => partial(k) && !isTotal(k)), ...keys.filter(isTotal)]
			: keys.filter((k) => !partial(k));

	return {
		rowKeys: order(rowKeys),
		colKeys: order(colKeys),
		cell: (rowKey, colKey, measure) =>
			cells.get(`${rowKey.join('')}${colKey.join('')}${measure}`) ?? null
	};
};

/** How a key path reads in a header cell. */
export const keyLabel = (key) => key.map((part) => (part === TOTAL ? 'Total' : part)).join(' · ');

/** Whether a key path is the roll-up rather than a value. */
export const isTotalKey = (key) => key.some((part) => part === TOTAL);
