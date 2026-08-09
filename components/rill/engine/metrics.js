/**
 * A Rill metrics view, compiled to DuckDB.
 *
 * Rill resolves a metrics view in its own Go runtime. There is no runtime here —
 * the site is static and the engine is duckdb-wasm in the reader's browser — so
 * the definitions have to compile to SQL instead. That is a deliberate trade:
 * the dashboard keeps working with nothing running, and in exchange every
 * number has to be provably the one the YAML declared.
 *
 * Two things make that provable rather than hopeful:
 *
 *   1. **One relation.** The model becomes a single DuckDB view, with every
 *      dimension expression materialised as a column on it. Every query below,
 *      and every Noodle worksheet built on the same metrics view, reads that one
 *      relation — so a dimension cannot mean one thing on a leaderboard and
 *      another on a pivot.
 *   2. **The measure expression is copied, never rebuilt.** A measure's SQL is
 *      the string from the YAML. Nothing here parses it, rewrites it, or infers
 *      an aggregation from a column name, because each of those is a way for the
 *      reported number to drift from the governed one.
 *
 * The comparison window is the other thing worth reading carefully. Both windows
 * are computed in a single pass over a single scan, labelled by a CASE, rather
 * than by running the query twice. Two scans would let a measure like
 * `count(distinct customer_id)` be evaluated against two different row sets and
 * then differenced — which is fine — but would also make it tempting to
 * subtract the two, which is not: distinct counts do not subtract. Keeping both
 * windows in one grouped result keeps each measure evaluated exactly once per
 * window, by its own expression, which is the only way a ratio or a distinct
 * count comes out right.
 */

import { filterSql, ident } from '../../noodle/engine/sql.js';
import { sqlTimestamp, truncExpression } from './timerange.js';

/** The DuckDB view a metrics view resolves to. */
export const viewName = (metricsView) => `rill_${metricsView.name}`;

/**
 * The identifiers a measure expression depends on.
 *
 * Used to tell the noodle compiler which columns must reach its `base` CTE. It
 * over-reports — a SQL keyword that happens to match a column name is counted —
 * and that is the safe direction: carrying a column nothing needs costs a
 * projected column, while missing one is a binder error at query time.
 */
export const expressionColumns = (expression, columns) => {
	const found = new Set();
	for (const column of columns) {
		if (new RegExp(`(^|[^A-Za-z0-9_."])${column}([^A-Za-z0-9_"]|$)`).test(expression)) found.add(column);
	}
	return [...found];
};

/**
 * `create or replace view` for a metrics view.
 *
 * Dimension expressions are materialised here rather than repeated at each call
 * site. `order_size` is a CASE over three bands; written out four times in four
 * queries it is four chances for the bands to disagree.
 *
 * @param {object} metricsView
 * @param {object} models keyed by name
 */
export const createViewSql = (metricsView, models) => {
	const model = models[metricsView.model];
	if (!model) throw new Error(`Rill model "${metricsView.model}" is not in the compiled project.`);

	const derived = metricsView.dimensions
		.filter((d) => !d.isColumn)
		.map((d) => `  ${d.expression} as ${ident(d.name)}`);

	return (
		`create or replace view ${ident(viewName(metricsView))} as\n` +
		`select\n  *${derived.length ? `,\n${derived.join(',\n')}` : ''}\n` +
		`from (\n${model.sql.replace(/^/gm, '  ')}\n)`
	);
};

/** A dimension's reference on the materialised view — always a plain column. */
export const dimensionRef = (dimension) => ident(dimension.name);

const findDimension = (metricsView, name) => metricsView.dimensions.find((d) => d.name === name);
const findMeasure = (metricsView, name) => metricsView.measures.find((m) => m.name === name);

/**
 * Render the dashboard's dimension filters as a WHERE fragment.
 *
 * `except` is how a leaderboard shows the values you have *not* picked. Rill
 * does the same thing, and the reason is worth stating: a leaderboard filtered
 * by its own dimension collapses to the one row you already selected, so there
 * is no way back without clearing the filter blind.
 *
 * @param {object} metricsView
 * @param {Record<string, {mode: 'include'|'exclude', values: unknown[]}>} filters
 * @param {string|null} [except] a dimension name to leave unfiltered
 */
export const filterClauses = (metricsView, filters = {}, except = null) => {
	const clauses = [];
	for (const [name, filter] of Object.entries(filters)) {
		if (name === except) continue;
		const dimension = findDimension(metricsView, name);
		if (!dimension || !filter?.values?.length) continue;
		const clause = filterSql(dimensionRef(dimension), {
			op: filter.mode === 'exclude' ? 'notIn' : 'in',
			values: filter.values
		});
		if (clause) clauses.push(clause);
	}
	return clauses;
};

/**
 * The scan every query starts from: the view, windowed, filtered, and labelled
 * with which of the two windows each row belongs to.
 */
const scanCte = (metricsView, { range, filters, except = null, includeComparison = true }) => {
	const ts = ident(metricsView.timeseries);
	const comparison = includeComparison ? range.comparison : null;
	const lower = comparison ? comparison.start : range.start;

	const where = [
		`${ts} >= ${sqlTimestamp(lower)}`,
		`${ts} < ${sqlTimestamp(range.end)}`,
		...filterClauses(metricsView, filters, except)
	];

	const window = comparison
		? `case when ${ts} >= ${sqlTimestamp(range.start)} then 'current' else 'comparison' end as _window`
		: `'current' as _window`;

	return (
		`scan as (\n  select *, ${window}\n  from ${ident(viewName(metricsView))}\n` +
		`  where ${where.join('\n    and ')}\n)`
	);
};

const measureSelects = (metricsView, names) =>
	names
		.map((name) => findMeasure(metricsView, name))
		.filter(Boolean)
		.map((m) => `${m.expression} as ${ident(m.name)}`);

/* ------------------------------------------------------------------ queries -- */

/** The extent of the timeseries column — what every relative range is anchored to. */
export const boundsSql = (metricsView) =>
	`select min(${ident(metricsView.timeseries)}) as lo, max(${ident(metricsView.timeseries)}) as hi, ` +
	`count(*) as rows from ${ident(viewName(metricsView))}`;

/**
 * Headline totals, one row per window.
 * @returns {string}
 */
export const totalsSql = (metricsView, { range, measures, filters }) =>
	`with ${scanCte(metricsView, { range, filters })}\n` +
	`select _window, ${measureSelects(metricsView, measures).join(', ')}\nfrom scan\ngroup by _window`;

/**
 * The trend: one row per bucket per window.
 *
 * The comparison series is emitted at its own timestamps rather than shifted
 * onto the current window's. Shifting in SQL means picking an offset, and a
 * calendar offset is not a fixed number of milliseconds — the component aligns
 * the two series by bucket index instead, where the alignment is visible.
 */
export const seriesSql = (metricsView, { range, measures, filters }) => {
	const bucket = truncExpression(ident(metricsView.timeseries), range.grain);
	return (
		`with ${scanCte(metricsView, { range, filters })}\n` +
		`select _window, ${bucket} as bucket, ${measureSelects(metricsView, measures).join(', ')}\n` +
		`from scan\ngroup by _window, bucket\norder by bucket`
	);
};

/**
 * A dimension leaderboard: every value, both windows, ranked by one measure.
 *
 * `limit` applies after ranking on the current window, not inside it, so a value
 * that exists only in the comparison window still appears — otherwise a segment
 * that collapsed to zero silently vanishes from the board that should be
 * showing exactly that.
 */
export const leaderboardSql = (metricsView, { dimension, measure, range, filters, limit = 12 }) => {
	const dim = findDimension(metricsView, dimension);
	const m = findMeasure(metricsView, measure);
	if (!dim || !m) return null;

	return (
		`with ${scanCte(metricsView, { range, filters, except: dimension })},\n` +
		`by_value as (\n` +
		`  select ${dimensionRef(dim)} as value, _window, ${m.expression} as ${ident(m.name)}\n` +
		`  from scan\n  group by 1, 2\n),\n` +
		`ranked as (\n` +
		`  select value,\n` +
		`         max(${ident(m.name)}) filter (where _window = 'current') as current,\n` +
		`         max(${ident(m.name)}) filter (where _window = 'comparison') as comparison\n` +
		`  from by_value\n  group by 1\n)\n` +
		`select value, current, comparison\nfrom ranked\n` +
		`order by current desc nulls last, value asc\nlimit ${Math.max(1, Math.min(limit, 200))}`
	);
};

/**
 * Time dimension detail: one measure, over time, split by a dimension.
 *
 * Restricted to named values so the chart cannot be handed a hundred series.
 * The caller passes the leaderboard's top values, which is what makes this read
 * as "expand the thing I am already looking at" rather than as a new question.
 */
export const detailSql = (metricsView, { dimension, measure, range, filters, values }) => {
	const dim = findDimension(metricsView, dimension);
	const m = findMeasure(metricsView, measure);
	if (!dim || !m) return null;

	const bucket = truncExpression(ident(metricsView.timeseries), range.grain);
	const restrict = values?.length
		? filterSql(dimensionRef(dim), { op: 'in', values })
		: null;

	return (
		`with ${scanCte(metricsView, { range, filters, except: dimension, includeComparison: false })}\n` +
		`select ${bucket} as bucket, ${dimensionRef(dim)} as value, ${m.expression} as ${ident(m.name)}\n` +
		`from scan\n` +
		(restrict ? `where ${restrict}\n` : '') +
		`group by 1, 2\norder by 1, 2`
	);
};

/** Distinct values of a dimension in the current window, for the filter picker. */
export const dimensionValuesSql = (metricsView, { dimension, range, filters, limit = 200 }) => {
	const dim = findDimension(metricsView, dimension);
	if (!dim) return null;
	return (
		`with ${scanCte(metricsView, { range, filters, except: dimension, includeComparison: false })}\n` +
		`select distinct ${dimensionRef(dim)} as value from scan\n` +
		`where ${dimensionRef(dim)} is not null\norder by 1\nlimit ${limit}`
	);
};

/* ------------------------------------------------------- the noodle bridge -- */

/**
 * The metrics view as a noodle catalog.
 *
 * This is the point of the whole integration. Noodle already explores anything
 * with a catalog; giving it one built from Rill means a governed measure is
 * draggable, and `avg_order_value` on a worksheet is the same expression as
 * `avg_order_value` on the dashboard rather than a re-derivation of it.
 *
 * Measures arrive with `aggExpression`, which the compiler emits verbatim and
 * which locks the aggregation dropdown — the semantic layer already decided,
 * and offering "Average of Average order value" would be offering nonsense.
 */
export const catalogFromMetricsView = (metricsView, models) => {
	const table = viewName(metricsView);
	const model = models[metricsView.model];
	const modelColumns = modelColumnNames(model, metricsView);

	const fields = [
		...metricsView.dimensions.map((d) => ({
			id: `${table}.${d.name}`,
			table,
			column: d.name,
			name: d.label,
			role: 'dimension',
			dataType: 'string',
			defaultAgg: 'countd',
			description: d.description ?? undefined
		})),
		{
			// The timeseries is a dimension too — Rill hides it behind the range
			// picker, but a worksheet needs to put time on an axis.
			id: `${table}.${metricsView.timeseries}`,
			table,
			column: metricsView.timeseries,
			name: 'Time',
			role: 'dimension',
			dataType: 'date',
			defaultAgg: 'countd',
			description: `The metrics view's timeseries column (${metricsView.timeseries}).`
		},
		...metricsView.measures.map((m) => ({
			id: `${table}.${m.name}`,
			table,
			column: m.name,
			name: m.label,
			role: 'measure',
			dataType: 'number',
			// `null` is the statement, not a missing value: the metrics view owns
			// the aggregation, so the shelf must not silently default it to sum.
			// `semantic` is the same flag the Cube catalog sets, and the shelf menu
			// reads it to close the aggregation list rather than offering a choice
			// it will then ignore.
			defaultAgg: null,
			semantic: true,
			aggExpression: m.expression,
			requires: expressionColumns(m.expression, modelColumns),
			aggLocked: `Defined by the Rill metrics view as ${m.expression}`,
			format: formatHint(m),
			description: m.description ?? undefined
		}))
	];

	return {
		tables: [{ name: table, label: metricsView.label, fieldCount: fields.length }],
		fields,
		relationships: [],
		byId: Object.fromEntries(fields.map((f) => [f.id, f]))
	};
};

/**
 * Column names the model projects, for dependency detection.
 *
 * Read off the model's SELECT list by alias, which is reliable here because the
 * generator already requires the model to be a plain projection. Dimension names
 * are added because a dimension expression becomes a column on the view.
 */
const modelColumnNames = (model, metricsView) => {
	const names = new Set(metricsView.dimensions.map((d) => d.name));
	if (!model) return [...names];
	const body = model.sql.replace(/--[^\n]*/g, ' ');
	const select = body.slice(body.search(/\bselect\b/i) + 6, body.search(/\bfrom\b/i));
	for (const part of splitTopLevel(select)) {
		const alias = /(?:\bas\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(part.trim());
		if (alias) names.add(alias[1]);
	}
	return [...names];
};

/** Split a SELECT list on commas that are not inside parentheses. */
const splitTopLevel = (text) => {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '(') depth += 1;
		else if (text[i] === ')') depth -= 1;
		else if (text[i] === ',' && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
};

/** Map a Rill format preset onto the Evidence format noodle already understands. */
const formatHint = (measure) => {
	switch (measure.formatPreset) {
		case 'currency_usd':
			return 'usd0';
		case 'currency_eur':
			return 'eur0';
		case 'percentage':
			return 'pct1';
		default:
			return 'num0';
	}
};
