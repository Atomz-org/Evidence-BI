/**
 * SQL construction primitives for the noodle compiler.
 *
 * Every identifier and literal that reaches a query passes through here. The
 * catalog is built by introspecting the warehouse, so identifiers are already
 * trustworthy, but filter values come from the browser and are not — nothing is
 * ever concatenated raw.
 */

/** DuckDB reserves double quotes for identifiers; a literal quote is doubled. */
export const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Qualify a possibly dotted table reference: `schema.table` -> `"schema"."table"`.
 */
export const tableRef = (name) => String(name).split('.').map(ident).join('.');

/**
 * A column reference qualified by its table.
 */
export const columnRef = (table, column) => `${tableRef(table)}.${ident(column)}`;

/**
 * Render a JS value as a SQL literal.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const lit = (value) => {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return 'null';
		return String(value);
	}
	if (value instanceof Date) {
		return `timestamp '${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
	}
	return `'${String(value).replace(/'/g, "''")}'`;
};

/** Aggregations the shelf UI can apply, and how each renders. */
export const AGGREGATIONS = {
	sum: { label: 'Sum', sql: (e) => `sum(${e})`, numericOnly: true },
	avg: { label: 'Average', sql: (e) => `avg(${e})`, numericOnly: true },
	median: { label: 'Median', sql: (e) => `median(${e})`, numericOnly: true },
	min: { label: 'Minimum', sql: (e) => `min(${e})`, numericOnly: false },
	max: { label: 'Maximum', sql: (e) => `max(${e})`, numericOnly: false },
	count: { label: 'Count', sql: () => `count(*)`, numericOnly: false },
	countd: { label: 'Count Distinct', sql: (e) => `count(distinct ${e})`, numericOnly: false },
	stddev: { label: 'Std. deviation', sql: (e) => `stddev_samp(${e})`, numericOnly: true }
};

/** Date truncations available on a temporal pill. */
export const DATE_PARTS = {
	year: { label: 'Year', trunc: 'year' },
	quarter: { label: 'Quarter', trunc: 'quarter' },
	month: { label: 'Month', trunc: 'month' },
	week: { label: 'Week', trunc: 'week' },
	day: { label: 'Day', trunc: 'day' },
	hour: { label: 'Hour', trunc: 'hour' }
};

/** Filter operators, keyed by the data type they apply to. */
export const FILTER_OPS = {
	in: { label: 'is one of', arity: 'many' },
	notIn: { label: 'is not one of', arity: 'many' },
	eq: { label: '=', arity: 'one' },
	ne: { label: '≠', arity: 'one' },
	gt: { label: '>', arity: 'one' },
	gte: { label: '≥', arity: 'one' },
	lt: { label: '<', arity: 'one' },
	lte: { label: '≤', arity: 'one' },
	between: { label: 'between', arity: 'two' },
	contains: { label: 'contains', arity: 'one' },
	isNull: { label: 'is null', arity: 'none' },
	notNull: { label: 'is not null', arity: 'none' }
};

/**
 * Render a filter as a boolean SQL expression.
 *
 * @param {string} expr the column expression being filtered
 * @param {{ op: string, values?: unknown[] }} filter
 * @returns {string | null} null when the filter is incomplete and should be ignored
 */
export const filterSql = (expr, filter) => {
	const values = filter.values ?? [];
	switch (filter.op) {
		case 'in':
			if (!values.length) return null;
			return `${expr} in (${values.map(lit).join(', ')})`;
		case 'notIn':
			if (!values.length) return null;
			return `${expr} not in (${values.map(lit).join(', ')})`;
		case 'eq':
			return values.length ? `${expr} = ${lit(values[0])}` : null;
		case 'ne':
			return values.length ? `${expr} <> ${lit(values[0])}` : null;
		case 'gt':
			return values.length ? `${expr} > ${lit(values[0])}` : null;
		case 'gte':
			return values.length ? `${expr} >= ${lit(values[0])}` : null;
		case 'lt':
			return values.length ? `${expr} < ${lit(values[0])}` : null;
		case 'lte':
			return values.length ? `${expr} <= ${lit(values[0])}` : null;
		case 'between':
			return values.length >= 2
				? `${expr} between ${lit(values[0])} and ${lit(values[1])}`
				: null;
		case 'contains':
			// Escape LIKE wildcards so a search box cannot become a pattern.
			return values.length
				? `${expr} ilike ${lit(`%${String(values[0]).replace(/[%_\\]/g, '\\$&')}%`)} escape '\\'`
				: null;
		case 'isNull':
			return `${expr} is null`;
		case 'notNull':
			return `${expr} is not null`;
		default:
			return null;
	}
};

/**
 * A deterministic, SQL-safe alias for a pill.
 *
 * Aliases are the contract between the compiler, the table calculations and the
 * chart encoder, so they must be stable for a given pill and unique within a
 * query.
 *
 * @param {string} base
 * @param {Set<string>} [taken]
 * @returns {string}
 */
export const uniqueAlias = (base, taken = new Set()) => {
	const cleaned =
		String(base)
			.replace(/[^A-Za-z0-9_]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.toLowerCase() || 'field';

	if (!taken.has(cleaned)) {
		taken.add(cleaned);
		return cleaned;
	}
	let n = 2;
	while (taken.has(`${cleaned}_${n}`)) n++;
	taken.add(`${cleaned}_${n}`);
	return `${cleaned}_${n}`;
};
