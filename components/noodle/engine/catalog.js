/**
 * The relationship layer — "noodle".
 *
 * A catalog is the list of fields a person can drag, plus the join graph that
 * lets fields from different tables appear in one view. It is built by
 * introspecting the warehouse, so it can never drift from the data, and then
 * refined by whatever semantics the project already declares.
 *
 * Three layers, in the order they are consulted:
 *
 *   1. **Relationship layer** — logical links between tables, declared once.
 *      Tables stay separate; a join is chosen per view, based on which fields
 *      the view actually uses. This is the dbt semantic model's job.
 *   2. **Physical layer** — the SQL join that a given view resolves to.
 *   3. **Blending** — for sources that cannot be joined at all, each is
 *      aggregated to a common grain and matched on shared dimensions.
 *
 * Only layers 1 and 2 are implemented here; see `planJoins`.
 */

import { tableRef, ident } from './sql.js';

/** DuckDB type names grouped into the roles the UI cares about. */
const TYPE_GROUPS = {
	number: [
		'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT',
		'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT',
		'FLOAT', 'DOUBLE', 'REAL', 'DECIMAL'
	],
	date: ['DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP_NS', 'TIMESTAMP_MS', 'TIMESTAMP_S', 'TIME'],
	boolean: ['BOOLEAN'],
	string: ['VARCHAR', 'CHAR', 'TEXT', 'BLOB', 'UUID', 'ENUM']
};

/**
 * @param {string} duckdbType
 * @returns {'number'|'date'|'boolean'|'string'}
 */
export const classifyType = (duckdbType) => {
	const upper = String(duckdbType ?? '').toUpperCase();
	const bare = upper.replace(/\(.*\)$/, '').trim();
	for (const [group, types] of Object.entries(TYPE_GROUPS)) {
		if (types.includes(bare)) return /** @type {any} */ (group);
	}
	if (bare.startsWith('DECIMAL')) return 'number';
	return 'string';
};

/**
 * Columns that are numeric but are identifiers, not quantities. Summing an id
 * is always a mistake, so they default to a dimension role.
 */
const ID_PATTERN = /(^|_)(id|key|code|number|no|pk|fk)$/i;

/**
 * Turn a column name into something readable: `order_amount_usd` -> `Order Amount USD`.
 */
export const humanize = (column) => {
	const ACRONYMS = new Set(['id', 'usd', 'eur', 'gbp', 'url', 'api', 'sku', 'utm', 'mtd', 'ytd', 'aov']);
	return String(column)
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.split(' ')
		.map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(' ');
};

/**
 * Guess a display format so numbers are never raw floats on screen.
 *
 * @param {string} column
 * @param {'number'|'date'|'boolean'|'string'} type
 * @returns {string | undefined}
 */
export const inferFormat = (column, type) => {
	if (type !== 'number') return undefined;
	const name = column.toLowerCase();
	if (/(_usd|_amount|revenue|price|cost|sales|spend|margin|profit)/.test(name)) return 'usd0';
	if (/(_pct|_percent|_rate|_share|ratio)/.test(name)) return 'pct1';
	return 'num0';
};

/**
 * Build catalog fields for one table from a DuckDB `describe` result.
 *
 * @param {string} table fully qualified table name
 * @param {{ column_name: string, column_type: string }[]} described
 * @param {object} [overrides] per-column overrides: { role, agg, format, name, hidden }
 * @returns {import('./types.js').Field[]}
 */
export const fieldsFromDescribe = (table, described, overrides = {}) => {
	const fields = [];

	for (const row of described) {
		const column = row.column_name ?? row.name;
		const override = overrides[column] ?? {};
		if (override.hidden) continue;

		const dataType = override.dataType ?? classifyType(row.column_type ?? row.type);
		const looksLikeId = ID_PATTERN.test(column);
		const role = override.role ?? (dataType === 'number' && !looksLikeId ? 'measure' : 'dimension');

		fields.push({
			id: `${table}.${column}`,
			table,
			column,
			name: override.name ?? humanize(column),
			role,
			dataType,
			defaultAgg:
				override.agg ??
				(role === 'measure' ? 'sum' : dataType === 'number' || looksLikeId ? 'countd' : 'countd'),
			format: override.format ?? inferFormat(column, dataType),
			description: override.description
		});
	}

	return fields;
};

/**
 * Introspect tables and assemble a catalog.
 *
 * @param {(sql: string) => Promise<any[]>} runQuery
 * @param {object} model
 * @param {string[]} model.tables fully qualified table names
 * @param {object} [model.fields] per-field overrides keyed `table.column`
 * @param {object[]} [model.relationships] logical links: { from, to, on: [[l, r], ...], type }
 * @param {Record<string,string>} [model.labels] display names per table
 * @returns {Promise<import('./types.js').Catalog>}
 */
export const buildCatalog = async (runQuery, model) => {
	const tables = [];
	const fields = [];

	for (const table of model.tables ?? []) {
		let described;
		try {
			described = await runQuery(`describe select * from ${tableRef(table)}`);
		} catch (e) {
			tables.push({ name: table, label: model.labels?.[table] ?? humanize(table.split('.').pop()), error: String(e?.message ?? e) });
			continue;
		}

		const overrides = {};
		for (const [key, value] of Object.entries(model.fields ?? {})) {
			const [t, c] = splitFieldKey(key);
			if (t === table) overrides[c] = value;
		}

		const tableFields = fieldsFromDescribe(table, described, overrides);
		fields.push(...tableFields);
		tables.push({
			name: table,
			label: model.labels?.[table] ?? humanize(table.split('.').pop()),
			fieldCount: tableFields.length
		});
	}

	return {
		tables,
		fields,
		relationships: model.relationships ?? [],
		byId: Object.fromEntries(fields.map((f) => [f.id, f]))
	};
};

/**
 * `schema.table.column` -> ['schema.table', 'column']
 */
const splitFieldKey = (key) => {
	const idx = key.lastIndexOf('.');
	return [key.slice(0, idx), key.slice(idx + 1)];
};

/**
 * Choose the physical joins needed to satisfy a set of fields.
 *
 * The relationship layer stays logical: tables are only joined when a view
 * actually reaches across them, which is what stops an unused dimension table
 * from changing a measure's grain.
 *
 * @param {import('./types.js').Catalog} catalog
 * @param {string} primary the table providing the view's grain
 * @param {string[]} fieldIds every field the view references
 * @returns {{ joins: object[], unreachable: string[] }}
 */
export const planJoins = (catalog, primary, fieldIds) => {
	const needed = new Set(
		fieldIds.map((id) => catalog.byId[id]?.table).filter((t) => t && t !== primary)
	);
	if (needed.size === 0) return { joins: [], unreachable: [] };

	/** adjacency over the declared relationships */
	const edges = new Map();
	for (const rel of catalog.relationships ?? []) {
		if (!edges.has(rel.from)) edges.set(rel.from, []);
		if (!edges.has(rel.to)) edges.set(rel.to, []);
		edges.get(rel.from).push({ ...rel, target: rel.to, flip: false });
		edges.get(rel.to).push({ ...rel, target: rel.from, flip: true });
	}

	// Breadth-first from the primary table so each reachable table joins along
	// its shortest path — the least fan-out for the same result.
	const required = new Set(needed);
	const visited = new Set([primary]);
	/** every table the search reached, in discovery order: table -> its join */
	const reached = new Map();
	const queue = [primary];

	while (queue.length && needed.size > 0) {
		const current = queue.shift();
		for (const edge of edges.get(current) ?? []) {
			if (visited.has(edge.target)) continue;
			visited.add(edge.target);
			queue.push(edge.target);
			reached.set(edge.target, {
				table: edge.target,
				type: edge.type ?? 'left',
				on: (edge.on ?? []).map(([l, r]) => (edge.flip ? [r, l] : [l, r])),
				fromTable: current
			});
			needed.delete(edge.target);
		}
	}

	// The search reaches every neighbour of every table it visits, not only the
	// ones the view asked for. Joining the surplus would defeat the guarantee
	// above: one stray left join across a one-to-many relationship fans out the
	// base rows and inflates every measure aggregated over them. So walk back
	// from each referenced table and keep only the joins on those paths.
	const keep = new Set();
	for (const table of required) {
		if (!reached.has(table)) continue;
		for (let node = table; node !== primary && !keep.has(node); node = reached.get(node).fromTable) {
			keep.add(node);
		}
	}

	// Discovery order already places each table after the one it joins from.
	const joins = [...reached.values()].filter((join) => keep.has(join.table));
	return { joins, unreachable: [...needed] };
};

/**
 * Render the FROM clause for a plan.
 *
 * @param {string} primary
 * @param {object[]} joins
 * @returns {string}
 */
export const fromClause = (primary, joins) => {
	let sql = tableRef(primary);
	for (const join of joins) {
		const conditions = join.on
			.map(([l, r]) => `${tableRef(join.fromTable)}.${ident(l)} = ${tableRef(join.table)}.${ident(r)}`)
			.join(' and ');
		sql += `\n  ${join.type} join ${tableRef(join.table)} on ${conditions || 'true'}`;
	}
	return sql;
};
