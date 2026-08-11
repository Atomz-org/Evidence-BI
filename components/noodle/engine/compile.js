/**
 * Compile a view specification into one SQL statement.
 *
 * The compiler's whole job is granularity. A view's grain is the set of
 * dimensions on its shelves; measures aggregate up to it. Level-of-detail
 * expressions exist precisely because some numbers must be computed at a
 * *different* grain and then brought back.
 *
 * Bringing them back is the subtle part. An LOD value computed at its own grain
 * must be aggregated into the view over its **distinct values**, not over the
 * underlying rows — otherwise the outer aggregate is silently weighted by row
 * counts and `AVG` returns a row-weighted mean instead of the mean of the inner
 * results. Each LOD therefore compiles to three steps: compute at its grain,
 * pair it with the view's grain distinctly, then aggregate into the view.
 *
 *   with base       as (row level, joins applied, dimensions materialised)
 *      , lod_n_src  as (base grouped at the LOD's own grain)
 *      , lod_n_pair as (distinct view-grain x LOD-grain, carrying the value)
 *      , lod_n_view as (lod_n_pair aggregated to the view's grain)
 *      , agg        as (base aggregated to the view's grain)
 *   select ... from agg left join lod_n_view using the view's grain
 */

import { AGGREGATIONS, DATE_PARTS, columnRef, filterSql, ident, lit, uniqueAlias } from './sql.js';
import { allPills, dimensionPills } from './spec.js';
import { fromClause, planJoins } from './catalog.js';

/**
 * The SQL expression for a dimension pill, before aliasing.
 */
export const dimensionExpr = (catalog, pill) => {
	const field = catalog.byId[pill.fieldId];
	if (!field) return null;
	const ref = columnRef(field.table, field.column);

	if (field.dataType === 'date' && pill.datePart) {
		const part = DATE_PARTS[pill.datePart]?.trunc ?? 'month';
		return `date_trunc(${lit(part)}, ${ref})`;
	}
	if (pill.bin && Number.isFinite(pill.bin) && pill.bin > 0) {
		return `floor(${ref} / ${lit(pill.bin)}) * ${lit(pill.bin)}`;
	}
	return ref;
};

/**
 * A stable identity for a dimension pill's *expression*, so two pills meaning
 * the same thing share one column and can be joined on.
 */
const dimensionSignature = (pill) => `${pill.fieldId}|${pill.datePart ?? ''}|${pill.bin ?? ''}`;

const aggregateExpr = (inner, agg) => (AGGREGATIONS[agg] ?? AGGREGATIONS.sum).sql(inner);

/** Null-safe equality, so joining on a dimension containing NULLs keeps its rows. */
const joinOn = (left, right, aliases) =>
	aliases.length
		? aliases.map((a) => `${left}.${ident(a)} is not distinct from ${right}.${ident(a)}`).join(' and ')
		: 'true';

/**
 * Every field a spec touches — shelves, level-of-detail dimensions, filters.
 */
export const referencedFields = (spec) =>
	[
		...allPills(spec).map((p) => p.fieldId),
		...allPills(spec).flatMap((p) => p.lod?.dims ?? []),
		...(spec.filters ?? []).map((f) => f.fieldId)
	].filter(Boolean);

/**
 * The table that provides a view's grain.
 *
 * Exported because the dashboard layer has to answer "can this tile even see
 * that field?" before it cross-filters — and it must answer it the same way the
 * compiler will, or the two disagree about which join graph is in play.
 */
export const resolvePrimary = (catalog, spec) =>
	spec.source?.primary ?? mostCommonTable(catalog, referencedFields(spec)) ?? catalog.tables[0]?.name;

/**
 * @param {import('./types.js').Catalog} catalog
 * @param {import('./types.js').Spec} spec
 * @returns {{ sql: string|null, columns: object[], warnings: string[], grain: string[] }}
 */
export const compile = (catalog, spec) => {
	const warnings = [];
	const pills = allPills(spec);

	if (!pills.length) {
		return { sql: null, columns: [], warnings: ['Drag a field onto a shelf to begin.'], grain: [] };
	}

	// ---------------------------------------------------------------- source --
	const referencedFieldIds = referencedFields(spec);

	const primary = resolvePrimary(catalog, spec);
	if (!primary) return { sql: null, columns: [], warnings: ['No table available.'], grain: [] };

	const { joins, unreachable } = planJoins(catalog, primary, referencedFieldIds);
	for (const table of unreachable) {
		warnings.push(
			`${table} has no declared relationship to ${primary} — its fields are ignored. ` +
				`Add a relationship, or blend the sources.`
		);
	}
	const reachable = new Set([primary, ...joins.map((j) => j.table)]);
	const usable = (pill) => reachable.has(catalog.byId[pill.fieldId]?.table);

	// ------------------------------------------------- dimensions in `base` --
	const dimAliasBySignature = new Map();
	const baseSelects = [];
	const takenAliases = new Set();

	const registerDim = (pill) => {
		if (!usable(pill)) return null;
		const signature = dimensionSignature(pill);
		if (dimAliasBySignature.has(signature)) return dimAliasBySignature.get(signature);

		const expr = dimensionExpr(catalog, pill);
		if (!expr) return null;

		const field = catalog.byId[pill.fieldId];
		const alias = uniqueAlias(
			pill.datePart ? `${field.column}_${pill.datePart}` : field.column,
			takenAliases
		);
		dimAliasBySignature.set(signature, alias);
		baseSelects.push(`${expr} as ${ident(alias)}`);
		return alias;
	};

	const viewDimPills = dimensionPills(spec).filter(usable);
	for (const pill of viewDimPills) registerDim(pill);

	/**
	 * A dimension named by an LOD must resolve to the same column the view uses,
	 * or EXCLUDE/INCLUDE would compare a month grain against a day grain.
	 */
	const lodDimPill = (fieldId) => {
		const inView = viewDimPills.find((p) => p.fieldId === fieldId);
		if (inView) return inView;
		const field = catalog.byId[fieldId];
		return {
			fieldId,
			role: 'dimension',
			datePart: field?.dataType === 'date' ? 'month' : null,
			bin: null
		};
	};

	for (const pill of pills) {
		for (const dimFieldId of pill.lod?.dims ?? []) {
			if (catalog.byId[dimFieldId]) registerDim(lodDimPill(dimFieldId));
		}
	}

	// ------------------------------------------------------ measures in base --
	const measureColumns = new Map();
	const carryMeasure = (fieldId) => {
		const field = catalog.byId[fieldId];
		if (!field || measureColumns.has(field.id) || !reachable.has(field.table)) return;
		const alias = uniqueAlias(`m_${field.column}`, takenAliases);
		measureColumns.set(field.id, alias);
		baseSelects.push(`${columnRef(field.table, field.column)} as ${ident(alias)}`);
	};

	for (const pill of pills) {
		if (pill.role === 'measure') carryMeasure(pill.fieldId);
		if (pill.lod?.fieldId) carryMeasure(pill.lod.fieldId);
	}
	for (const filter of spec.filters) {
		if (filter.role === 'measure') carryMeasure(filter.fieldId);
	}

	if (!baseSelects.length) {
		return { sql: null, columns: [], warnings: [...warnings, 'Nothing to query.'], grain: [] };
	}

	// ------------------------------------------------------------- filters ---
	const whereClauses = [];
	for (const filter of spec.filters) {
		const field = catalog.byId[filter.fieldId];
		if (!field || !reachable.has(field.table) || filter.role === 'measure') continue;
		const clause = filterSql(columnRef(field.table, field.column), filter);
		if (clause) whereClauses.push(clause);
	}

	const ctes = [
		`base as (\n  select\n    ${baseSelects.join(',\n    ')}\n  from ${fromClause(primary, joins)}` +
			(whereClauses.length ? `\n  where ${whereClauses.join('\n    and ')}` : '') +
			`\n)`
	];

	const viewDimAliases = viewDimPills
		.map((p) => dimAliasBySignature.get(dimensionSignature(p)))
		.filter(Boolean);
	const viewDimList = viewDimAliases.map((a) => ident(a));

	// ------------------------------------------------------------------ LOD ---
	/** @type {{pill: object, cte: string, valueAlias: string}[]} */
	const lodViews = [];

	pills.forEach((pill, index) => {
		if (!pill.lod || !usable(pill)) return;

		const declared = (pill.lod.dims ?? [])
			.map((id) => (catalog.byId[id] ? dimAliasBySignature.get(dimensionSignature(lodDimPill(id))) : null))
			.filter(Boolean);

		let grainAliases;
		if (pill.lod.kind === 'FIXED') {
			grainAliases = [...new Set(declared)];
		} else if (pill.lod.kind === 'INCLUDE') {
			grainAliases = [...new Set([...viewDimAliases, ...declared])];
		} else {
			const drop = new Set(declared);
			grainAliases = viewDimAliases.filter((a) => !drop.has(a));
		}

		const measureAlias = measureColumns.get(pill.lod.fieldId ?? pill.fieldId);
		if (!measureAlias) {
			warnings.push('Level-of-detail expression skipped: its measure is not available.');
			return;
		}

		const src = `lod_${index}_src`;
		const pair = `lod_${index}_pair`;
		const view = `lod_${index}_view`;
		const valueAlias = `lod_${index}_value`;
		const grainList = grainAliases.map((a) => ident(a));

		// 1. the LOD's own grain
		ctes.push(
			`${src} as (\n  select ${[...grainList, `${aggregateExpr(ident(measureAlias), pill.lod.agg ?? 'sum')} as ${ident(valueAlias)}`].join(', ')}` +
				`\n  from base` +
				(grainList.length ? `\n  group by ${grainList.join(', ')}` : '') +
				`\n)`
		);

		// 2. pair it with the view's grain, distinctly — this is what stops the
		//    outer aggregate being weighted by the number of underlying rows.
		const pairKeys = [...new Set([...viewDimAliases, ...grainAliases])].map((a) => ident(a));
		ctes.push(
			`${pair} as (\n  select distinct ${[...pairKeys.map((k) => `base.${k}`), `${src}.${ident(valueAlias)}`].join(', ')}` +
				`\n  from base\n  left join ${src} on ${joinOn('base', src, grainAliases)}\n)`
		);

		// 3. aggregate into the view
		ctes.push(
			`${view} as (\n  select ${[...viewDimList, `${aggregateExpr(ident(valueAlias), pill.agg ?? 'avg')} as ${ident(valueAlias)}`].join(', ')}` +
				`\n  from ${pair}` +
				(viewDimList.length ? `\n  group by ${viewDimList.join(', ')}` : '') +
				`\n)`
		);

		lodViews.push({ pill, cte: view, valueAlias });
	});

	// ------------------------------------------------------------ the view ---
	const columns = [];
	const aggSelects = [...viewDimList];
	const measureAliases = new Set();

	for (const pill of viewDimPills) {
		const alias = dimAliasBySignature.get(dimensionSignature(pill));
		if (!alias) continue;
		const field = catalog.byId[pill.fieldId];
		columns.push({
			alias,
			pill,
			role: 'dimension',
			shelf: shelfOf(spec, pill),
			dataType: field?.dataType,
			label: field?.name,
			format: pill.format
		});
	}

	const finalSelects = [...viewDimList.map((d) => `agg.${d} as ${d}`)];

	for (const pill of pills) {
		if (pill.role !== 'measure' || !usable(pill)) continue;
		const field = catalog.byId[pill.fieldId];

		const alias = uniqueAlias(
			pill.lod ? `${pill.lod.kind.toLowerCase()}_${field?.column ?? 'value'}` : `${pill.agg ?? 'sum'}_${field?.column ?? 'value'}`,
			new Set([...takenAliases, ...measureAliases])
		);

		if (pill.lod) {
			const lodView = lodViews.find((v) => v.pill.key === pill.key);
			if (!lodView) continue;
			finalSelects.push(`${lodView.cte}.${ident(lodView.valueAlias)} as ${ident(alias)}`);
		} else {
			const expr =
				pill.agg === 'count'
					? 'count(*)'
					: (() => {
							const measureAlias = measureColumns.get(field?.id);
							return measureAlias ? aggregateExpr(ident(measureAlias), pill.agg ?? 'sum') : null;
						})();
			if (!expr) continue;
			aggSelects.push(`${expr} as ${ident(alias)}`);
			finalSelects.push(`agg.${ident(alias)}`);
		}

		measureAliases.add(alias);
		columns.push({
			alias,
			pill,
			role: 'measure',
			shelf: shelfOf(spec, pill),
			dataType: 'number',
			label: field?.name,
			format: pill.format ?? field?.format
		});
	}

	if (!columns.length) {
		return { sql: null, columns: [], warnings: [...warnings, 'Nothing to show yet.'], grain: [] };
	}

	const havingClauses = [];
	for (const filter of spec.filters) {
		if (filter.role !== 'measure') continue;
		const measureAlias = measureColumns.get(filter.fieldId);
		if (!measureAlias) continue;
		const clause = filterSql(aggregateExpr(ident(measureAlias), filter.agg ?? 'sum'), filter);
		if (clause) havingClauses.push(clause);
	}

	ctes.push(
		`agg as (\n  select ${aggSelects.length ? aggSelects.join(', ') : '1'}\n  from base` +
			(viewDimList.length ? `\n  group by ${viewDimList.join(', ')}` : '') +
			(havingClauses.length ? `\n  having ${havingClauses.join('\n    and ')}` : '') +
			`\n)`
	);

	const lodJoinSql = lodViews
		.map((v) => `\n  left join ${v.cte} on ${joinOn('agg', v.cte, viewDimAliases)}`)
		.join('');

	const orderBy = buildOrderBy(spec, columns);
	const limit = Number.isFinite(spec.limit) ? Math.max(1, Math.min(spec.limit, 50000)) : 5000;

	// The projection is wrapped so ORDER BY binds to output columns. Without it,
	// a dimension that also exists on a joined LOD view is ambiguous to the binder.
	const sql =
		`with ${ctes.join(',\n')}\nselect * from (\n  select ${finalSelects.join(', ')}\n  from agg${lodJoinSql.replace(/\n  /g, '\n  ')}\n)` +
		(orderBy ? `\norder by ${orderBy}` : '') +
		`\nlimit ${limit}`;

	return { sql, columns, warnings, grain: viewDimAliases };
};

/**
 * Default ordering: an explicit pill sort wins; otherwise order by the first
 * dimension so time reads left to right and categories are stable between runs.
 */
const buildOrderBy = (spec, columns) => {
	const explicit = columns
		.filter((c) => c.pill.sort)
		.map((c) => {
			const by = c.pill.sort.by === 'value' ? (columns.find((x) => x.role === 'measure')?.alias ?? c.alias) : c.alias;
			return `${ident(by)} ${c.pill.sort.dir === 'desc' ? 'desc' : 'asc'} nulls last`;
		});
	if (explicit.length) return explicit.join(', ');

	const firstDim = columns.find((c) => c.role === 'dimension');
	return firstDim ? `${ident(firstDim.alias)} asc nulls last` : null;
};

const shelfOf = (spec, pill) => {
	for (const shelf of ['columns', 'rows', 'detail', 'tooltip']) {
		if (spec[shelf].some((p) => p.key === pill.key)) return shelf;
	}
	for (const shelf of ['color', 'size', 'label']) {
		if (spec[shelf]?.key === pill.key) return shelf;
	}
	return null;
};

const mostCommonTable = (catalog, fieldIds) => {
	const counts = new Map();
	for (const id of fieldIds) {
		const table = catalog.byId[id]?.table;
		if (table) counts.set(table, (counts.get(table) ?? 0) + 1);
	}
	let best = null;
	let bestCount = 0;
	for (const [table, count] of counts) {
		if (count > bestCount) {
			best = table;
			bestCount = count;
		}
	}
	return best;
};
