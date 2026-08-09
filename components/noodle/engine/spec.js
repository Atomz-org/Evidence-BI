/**
 * The view specification — noodle's answer to Tableau's VizQL.
 *
 * A view is not a chart. It is a declaration of which fields sit on which
 * shelf, at what aggregation and granularity. The chart is derived from that;
 * so is the SQL. Keeping the two downstream of one declaration is what lets the
 * mark type change without touching the query, and the query change without
 * touching the mark.
 */

import { AGGREGATIONS, DATE_PARTS } from './sql.js';

/** Shelves that accept an ordered list of pills. */
export const LIST_SHELVES = ['columns', 'rows', 'detail', 'tooltip'];
/** Shelves that accept at most one pill. */
export const SINGLE_SHELVES = ['color', 'size', 'label'];
export const ALL_SHELVES = [...LIST_SHELVES, ...SINGLE_SHELVES];

let pillCounter = 0;

/**
 * @param {import('./types.js').Field} field
 * @param {object} [options]
 * @returns {import('./types.js').Pill}
 */
export const makePill = (field, options = {}) => {
	const isMeasure = (options.role ?? field.role) === 'measure';

	// A measure on a shelf is aggregated by the shelf — unless it comes from a
	// semantic layer, which already owns its aggregation. `defaultAgg: null` on a
	// semantic field is a statement, not a missing value, so it is not defaulted.
	const agg = isMeasure
		? (options.agg ?? field.defaultAgg ?? (field.semantic ? null : 'sum'))
		: null;

	return {
		key: `pill_${++pillCounter}`,
		fieldId: field.id,
		role: options.role ?? field.role,
		agg,
		datePart: field.dataType === 'date' ? (options.datePart ?? 'month') : null,
		bin: options.bin ?? null,
		sort: options.sort ?? null,
		calc: options.calc ?? null,
		lod: options.lod ?? null,
		format: options.format ?? field.format
	};
};

/** Reset the pill counter — tests only, so keys are deterministic. */
export const __resetPillCounter = () => {
	pillCounter = 0;
};

/**
 * @returns {import('./types.js').Spec}
 */
export const emptySpec = (primary = null) => ({
	source: { primary, joins: [] },
	columns: [],
	rows: [],
	color: null,
	size: null,
	label: null,
	detail: [],
	tooltip: [],
	filters: [],
	mark: 'auto',
	stacked: true,
	limit: 5000
});

/**
 * Human-readable name for a pill, matching how it reads on screen.
 *
 * @param {import('./types.js').Catalog} catalog
 * @param {import('./types.js').Pill} pill
 */
export const pillLabel = (catalog, pill) => {
	const field = catalog.byId[pill.fieldId];
	const name = field?.name ?? pill.fieldId;

	if (pill.calc) return `${calcLabel(pill.calc)} of ${aggLabel(pill, name)}`;
	if (pill.lod) return lodLabel(catalog, pill);
	return aggLabel(pill, name);
};

const aggLabel = (pill, name) => {
	if (pill.role === 'measure' && pill.agg) {
		if (pill.agg === 'count') return 'Count of Records';
		return `${AGGREGATIONS[pill.agg]?.label ?? pill.agg} of ${name}`;
	}
	if (pill.datePart) return `${DATE_PARTS[pill.datePart]?.label ?? pill.datePart} of ${name}`;
	if (pill.bin) return `${name} (bins of ${pill.bin})`;
	return name;
};

const lodLabel = (catalog, pill) => {
	const dims = (pill.lod.dims ?? []).map((id) => catalog.byId[id]?.name ?? id).join(', ');
	const inner = `${AGGREGATIONS[pill.lod.agg]?.label ?? pill.lod.agg} of ${catalog.byId[pill.fieldId]?.name ?? pill.fieldId}`;
	return `{${pill.lod.kind} [${dims}] : ${inner}}`;
};

const calcLabel = (calc) =>
	({
		runningTotal: 'Running total',
		movingAverage: `Moving average (${calc.window ?? 3})`,
		percentOfTotal: 'Percent of total',
		rank: 'Rank',
		difference: 'Difference',
		percentDifference: 'Percent difference'
	})[calc.type] ?? calc.type;

/**
 * Whether a pill may be dropped on a shelf. The rules are what make the surface
 * feel intentional rather than permissive.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export const canDrop = (catalog, field, shelf) => {
	if (!ALL_SHELVES.includes(shelf)) return { ok: false, reason: 'Unknown shelf' };
	if (shelf === 'size' && field.role !== 'measure') {
		return { ok: false, reason: 'Size encodes quantity — drop a measure here' };
	}
	return { ok: true };
};

/** Immutably place a field on a shelf. */
export const dropField = (spec, catalog, field, shelf, index = null) => {
	const pill = makePill(field);
	const next = { ...spec };

	if (SINGLE_SHELVES.includes(shelf)) {
		next[shelf] = pill;
		return next;
	}

	const list = [...spec[shelf]];
	list.splice(index ?? list.length, 0, pill);
	next[shelf] = list;
	return next;
};

/** Immutably remove a pill from wherever it sits. */
export const removePill = (spec, pillKey) => {
	const next = { ...spec };
	for (const shelf of LIST_SHELVES) next[shelf] = spec[shelf].filter((p) => p.key !== pillKey);
	for (const shelf of SINGLE_SHELVES) {
		if (spec[shelf]?.key === pillKey) next[shelf] = null;
	}
	return next;
};

/** Immutably replace a pill's settings. */
export const updatePill = (spec, pillKey, patch) => {
	const apply = (p) => (p && p.key === pillKey ? { ...p, ...patch } : p);
	const next = { ...spec };
	for (const shelf of LIST_SHELVES) next[shelf] = spec[shelf].map(apply);
	for (const shelf of SINGLE_SHELVES) next[shelf] = apply(spec[shelf]);
	return next;
};

/** Move a pill between shelves, preserving its settings. */
export const movePill = (spec, pillKey, toShelf, index = null) => {
	const pill = allPills(spec).find((p) => p.key === pillKey);
	if (!pill) return spec;

	const without = removePill(spec, pillKey);
	if (SINGLE_SHELVES.includes(toShelf)) return { ...without, [toShelf]: pill };

	const list = [...without[toShelf]];
	list.splice(index ?? list.length, 0, pill);
	return { ...without, [toShelf]: list };
};

/** Swap the Rows and Columns shelves. */
export const transpose = (spec) => ({ ...spec, columns: spec.rows, rows: spec.columns });

/** Every pill in the spec, in shelf order. */
export const allPills = (spec) => [
	...spec.columns,
	...spec.rows,
	...(spec.color ? [spec.color] : []),
	...(spec.size ? [spec.size] : []),
	...(spec.label ? [spec.label] : []),
	...spec.detail,
	...spec.tooltip
];

/** Pills that establish the view's granularity. */
export const dimensionPills = (spec) =>
	allPills(spec).filter((p) => p.role === 'dimension');

/** Pills that produce numbers. */
export const measurePills = (spec) => allPills(spec).filter((p) => p.role === 'measure');

/**
 * A summary of the view's shape — the input to Show Me and to mark selection.
 */
export const shapeOf = (spec, catalog) => {
	const dims = dimensionPills(spec);
	const measures = measurePills(spec);
	const temporal = dims.filter((p) => catalog.byId[p.fieldId]?.dataType === 'date');

	return {
		dimensions: dims.length,
		measures: measures.length,
		temporal: temporal.length,
		colorRole: spec.color?.role ?? null,
		columnsAreMeasures: spec.columns.every((p) => p.role === 'measure') && spec.columns.length > 0,
		rowsAreMeasures: spec.rows.every((p) => p.role === 'measure') && spec.rows.length > 0,
		hasColumns: spec.columns.length > 0,
		hasRows: spec.rows.length > 0
	};
};
