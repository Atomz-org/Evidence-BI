/**
 * Cube as noodle's semantic layer.
 *
 * Cube is a relationship layer that already knows what a measure means, how it
 * aggregates, which dimensions belong to it and which cubes can be joined. When
 * it is available, noodle stops guessing: the catalog is Cube's model rather
 * than warehouse introspection, and the shelves compile to a **Cube query**
 * rather than to SQL, so Cube resolves joins, security context and
 * pre-aggregations exactly as it does for every other client.
 *
 * The specification model does not change. One set of shelves, two backends:
 *
 *   spec ──> compile.js   ──> DuckDB SQL   (introspected catalog)
 *        └─> cube.js      ──> Cube query   (semantic catalog)
 *
 * Contracts here follow `packages/cubejs-client-core/src/types.ts` in the
 * vendored fork — `Cube`, `TCubeMeasure`, `TCubeDimension`, `Query`,
 * `LoadResponse` — not a reconstruction of them.
 */

const META_PATH = '/cubejs-api/v1/meta';
const LOAD_PATH = '/cubejs-api/v1/load';
const SQL_PATH = '/cubejs-api/v1/sql';

/** Cube reports every member as one of four types. */
const TYPE_MAP = {
	time: 'date',
	number: 'number',
	string: 'string',
	boolean: 'boolean'
};

/**
 * Cube granularity names, in the order noodle offers them. Cube models may add
 * custom granularities; those are appended per-dimension from the meta.
 */
export const CUBE_GRANULARITIES = ['year', 'quarter', 'month', 'week', 'day', 'hour'];

/**
 * Translate a Cube member format into an Evidence format string.
 *
 * Cube states intent (`currency` + ISO code, `percent`); Evidence states
 * presentation. Mapping here means a number formatted by Cube's model looks the
 * same on an exploration surface as it does on a published page.
 */
export const formatFor = (member) => {
	const format = typeof member?.format === 'string' ? member.format : member?.format?.type;

	if (format === 'currency' || /^currency(_\d)?$/.test(format ?? '')) {
		const precision = /_(\d)$/.exec(format ?? '')?.[1];
		const code = member.currency && member.currency !== 'USD' ? member.currency.toLowerCase() : 'usd';
		return `${code}${precision ?? '0'}`;
	}
	if (format === 'percent' || /^percent(_\d)?$/.test(format ?? '')) {
		return `pct${/_(\d)$/.exec(format ?? '')?.[1] ?? '1'}`;
	}
	if (/^(number|decimal|abbr|accounting)(_(\d))?$/.test(format ?? '')) {
		return `num${/_(\d)$/.exec(format ?? '')?.[1] ?? '0'}`;
	}
	return undefined;
};

/**
 * Build a noodle catalog from a Cube meta response.
 *
 * Cube member names are already qualified (`Orders.revenue`), so they are used
 * as field ids unchanged — a noodle spec built against Cube is therefore
 * expressed in Cube's own vocabulary and can be read back as a Cube query.
 *
 * @param {{ cubes: any[] }} meta the body of GET /cubejs-api/v1/meta
 * @param {object} [options]
 * @param {boolean} [options.viewsOnly] expose only `type: 'view'` cubes — the
 *   curated surface a Cube project intends for consumers
 * @returns {import('./types.js').Catalog}
 */
export const catalogFromCubeMeta = (meta, options = {}) => {
	const cubes = (meta?.cubes ?? []).filter((cube) => {
		if (cube.public === false || cube.isVisible === false) return false;
		if (options.viewsOnly) return cube.type === 'view';
		return true;
	});

	const tables = [];
	const fields = [];
	const segments = [];

	for (const cube of cubes) {
		const visible = (member) => member.public !== false && member.isVisible !== false;

		for (const measure of (cube.measures ?? []).filter(visible)) {
			fields.push({
				id: measure.name,
				table: cube.name,
				column: measure.name.split('.').pop(),
				name: measure.shortTitle ?? measure.title ?? measure.name,
				description: measure.description,
				role: 'measure',
				dataType: 'number',
				// Cube owns the aggregation. Re-aggregating a modelled measure is
				// how governed numbers quietly stop matching the model.
				defaultAgg: null,
				aggType: measure.aggType,
				cumulative: !!measure.cumulative,
				drillMembers: measure.drillMembers ?? [],
				format: formatFor(measure),
				semantic: true
			});
		}

		for (const dimension of (cube.dimensions ?? []).filter(visible)) {
			const dataType = TYPE_MAP[dimension.type] ?? 'string';
			fields.push({
				id: dimension.name,
				table: cube.name,
				column: dimension.name.split('.').pop(),
				name: dimension.shortTitle ?? dimension.title ?? dimension.name,
				description: dimension.description,
				role: 'dimension',
				dataType,
				primaryKey: !!dimension.primaryKey,
				granularities:
					dataType === 'date'
						? [
								...CUBE_GRANULARITIES,
								...(dimension.granularities ?? []).map((g) => g.name)
							].filter((v, i, a) => a.indexOf(v) === i)
						: null,
				format: formatFor(dimension),
				semantic: true
			});
		}

		for (const segment of (cube.segments ?? []).filter(visible)) {
			segments.push({
				id: segment.name,
				table: cube.name,
				name: segment.shortTitle ?? segment.title ?? segment.name,
				description: segment.description
			});
		}

		tables.push({
			name: cube.name,
			label: cube.title ?? cube.name,
			description: cube.description,
			kind: cube.type ?? 'cube',
			// Cube computes the join graph; cubes sharing a component are joinable.
			connectedComponent: cube.connectedComponent ?? null,
			fieldCount: (cube.measures?.length ?? 0) + (cube.dimensions?.length ?? 0)
		});
	}

	return {
		source: 'cube',
		tables,
		fields,
		segments,
		relationships: [],
		byId: Object.fromEntries(fields.map((f) => [f.id, f]))
	};
};

/**
 * Whether every field in a view can be queried together.
 *
 * Cube will not join across disconnected components, so noodle says so before
 * the query is sent rather than surfacing Cube's error afterwards.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export const checkJoinable = (catalog, fieldIds) => {
	const components = new Map();
	for (const id of fieldIds) {
		const table = catalog.byId[id]?.table;
		if (!table) continue;
		const meta = catalog.tables.find((t) => t.name === table);
		if (meta?.connectedComponent == null) continue;
		if (!components.has(meta.connectedComponent)) components.set(meta.connectedComponent, new Set());
		components.get(meta.connectedComponent).add(table);
	}

	if (components.size <= 1) return { ok: true };

	const groups = [...components.values()].map((set) => [...set].join(', '));
	return {
		ok: false,
		reason:
			`These cubes are not joined in the Cube model, so they cannot appear in one view: ` +
			`${groups.join(' | ')}. Add a join in the Cube schema, or query them separately.`
	};
};

/** noodle filter operators -> Cube operators. */
const OPERATOR_MAP = {
	in: 'equals',
	notIn: 'notEquals',
	eq: 'equals',
	ne: 'notEquals',
	gt: 'gt',
	gte: 'gte',
	lt: 'lt',
	lte: 'lte',
	contains: 'contains',
	isNull: 'notSet',
	notNull: 'set'
};

/**
 * Compile a noodle specification into a Cube query.
 *
 * @param {import('./types.js').Catalog} catalog
 * @param {import('./types.js').Spec} spec
 * @param {object} [options]
 * @returns {{ query: object|null, columns: object[], warnings: string[] }}
 */
export const compileCubeQuery = (catalog, spec, options = {}) => {
	const warnings = [];
	const pills = [
		...spec.columns,
		...spec.rows,
		...(spec.color ? [spec.color] : []),
		...(spec.size ? [spec.size] : []),
		...(spec.label ? [spec.label] : []),
		...spec.detail,
		...spec.tooltip
	];

	if (!pills.length) {
		return { query: null, columns: [], warnings: ['Drag a field onto a shelf to begin.'] };
	}

	const referenced = [...pills.map((p) => p.fieldId), ...spec.filters.map((f) => f.fieldId)];
	const joinable = checkJoinable(catalog, referenced);
	if (!joinable.ok) return { query: null, columns: [], warnings: [joinable.reason] };

	/** @type {object} */
	const query = { measures: [], dimensions: [], timeDimensions: [], filters: [], limit: spec.limit ?? 5000 };
	const columns = [];
	const seen = new Set();

	for (const pill of pills) {
		const field = catalog.byId[pill.fieldId];
		if (!field || seen.has(pill.fieldId + (pill.datePart ?? ''))) continue;
		seen.add(pill.fieldId + (pill.datePart ?? ''));

		if (field.role === 'measure') {
			if (pill.agg && pill.agg !== field.defaultAgg) {
				warnings.push(
					`${field.name} is defined in the Cube model — its aggregation comes from the model, ` +
						`not from the shelf. The "${pill.agg}" setting is ignored.`
				);
			}
			if (pill.lod) {
				warnings.push(
					`Level-of-detail expressions are a noodle construct and do not exist in a Cube ` +
						`query. Model this as a sub-query dimension in Cube instead.`
				);
			}
			query.measures.push(field.id);
			// Cube returns members keyed by their qualified name.
			columns.push({
				alias: field.id,
				pill,
				role: 'measure',
				dataType: 'number',
				label: field.name,
				format: field.format,
				shelf: shelfOf(spec, pill)
			});
			continue;
		}

		if (field.dataType === 'date') {
			const granularity = pill.datePart ?? 'month';
			query.timeDimensions.push({ dimension: field.id, granularity });
			columns.push({
				alias: `${field.id}.${granularity}`,
				pill,
				role: 'dimension',
				dataType: 'date',
				label: field.name,
				shelf: shelfOf(spec, pill)
			});
			continue;
		}

		query.dimensions.push(field.id);
		columns.push({
			alias: field.id,
			pill,
			role: 'dimension',
			dataType: field.dataType,
			label: field.name,
			format: field.format,
			shelf: shelfOf(spec, pill)
		});
	}

	// ------------------------------------------------------------- filters --
	for (const filter of spec.filters) {
		const field = catalog.byId[filter.fieldId];
		if (!field) continue;

		if (filter.op === 'between' && (filter.values ?? []).length >= 2) {
			if (field.dataType === 'date') {
				query.timeDimensions.push({
					dimension: field.id,
					dateRange: [String(filter.values[0]), String(filter.values[1])]
				});
			} else {
				query.filters.push({ member: field.id, operator: 'gte', values: [String(filter.values[0])] });
				query.filters.push({ member: field.id, operator: 'lte', values: [String(filter.values[1])] });
			}
			continue;
		}

		const operator = OPERATOR_MAP[filter.op];
		if (!operator) {
			warnings.push(`Filter operator "${filter.op}" has no Cube equivalent and was skipped.`);
			continue;
		}
		if (operator === 'set' || operator === 'notSet') {
			query.filters.push({ member: field.id, operator });
			continue;
		}
		const values = (filter.values ?? []).map((v) => (v instanceof Date ? v.toISOString() : String(v)));
		if (!values.length) continue;
		query.filters.push({ member: field.id, operator, values });
	}

	if (spec.segments?.length) query.segments = [...spec.segments];

	// --------------------------------------------------------------- order --
	const sorted = columns.find((c) => c.pill.sort);
	if (sorted) {
		const target = sorted.pill.sort.by === 'value'
			? (columns.find((c) => c.role === 'measure')?.alias ?? sorted.alias)
			: sorted.pill.fieldId;
		query.order = { [target]: sorted.pill.sort.dir === 'desc' ? 'desc' : 'asc' };
	} else {
		const firstTime = query.timeDimensions.find((t) => t.granularity);
		if (firstTime) query.order = { [firstTime.dimension]: 'asc' };
	}

	// Cube rejects empty arrays for some keys; send only what is populated.
	for (const key of ['measures', 'dimensions', 'timeDimensions', 'filters']) {
		if (!query[key].length) delete query[key];
	}

	if (!query.measures && !query.dimensions && !query.timeDimensions) {
		return { query: null, columns: [], warnings: [...warnings, 'Nothing to query yet.'] };
	}

	if (options.timezone) query.timezone = options.timezone;

	return { query, columns, warnings };
};

/**
 * Emit the view as a query for Cube's **SQL API** — the form Evidence can put
 * in `sources/`.
 *
 * This is the exit from exploration into BI-as-code. Cube's SQL API speaks the
 * Postgres wire protocol, so an Evidence source using the existing postgres
 * connector can run this and materialise it to parquet, which then feeds pages
 * and notebooks alike. Measures are wrapped in `MEASURE()` so Cube applies the
 * model's aggregation rather than a SQL one, and cubes are combined with
 * `CROSS JOIN`, which Cube resolves through its own join graph.
 *
 * @param {import('./types.js').Catalog} catalog
 * @param {import('./types.js').Spec} spec
 * @returns {{ sql: string|null, columns: object[], warnings: string[] }}
 */
export const toCubeSql = (catalog, spec) => {
	const { query, columns, warnings } = compileCubeQuery(catalog, spec);
	if (!query) return { sql: null, columns: [], warnings };

	const usedCubes = new Set();
	const selects = [];
	const groupBy = [];
	const outColumns = [];

	const shortName = (memberId) => memberId.split('.').slice(1).join('.');
	const cubeOf = (memberId) => memberId.split('.')[0];
	const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

	for (const column of columns) {
		const memberId = column.pill.fieldId;
		usedCubes.add(cubeOf(memberId));
		const ref = `${quote(cubeOf(memberId))}.${quote(shortName(memberId))}`;
		const alias = shortName(memberId).replace(/[^A-Za-z0-9_]/g, '_');

		if (column.role === 'measure') {
			selects.push(`MEASURE(${ref}) as ${quote(alias)}`);
		} else if (column.dataType === 'date') {
			const granularity = column.pill.datePart ?? 'month';
			selects.push(`DATE_TRUNC('${granularity}', ${ref}) as ${quote(alias)}`);
			// Group by ordinal, and the ordinal is this column's position in the
			// select list — not a running count of dimensions, which would group
			// by whichever measure happened to sit at that index.
			groupBy.push(selects.length);
		} else {
			selects.push(`${ref} as ${quote(alias)}`);
			groupBy.push(selects.length);
		}

		outColumns.push({ ...column, alias });
	}

	for (const filter of spec.filters) usedCubes.add(cubeOf(filter.fieldId));
	for (const segment of spec.segments ?? []) usedCubes.add(cubeOf(segment));

	const cubes = [...usedCubes];
	if (!cubes.length || !selects.length) return { sql: null, columns: [], warnings };

	const where = [];
	for (const filter of spec.filters) {
		const ref = `${quote(cubeOf(filter.fieldId))}.${quote(shortName(filter.fieldId))}`;
		const values = (filter.values ?? []).map((v) => `'${String(v).replace(/'/g, "''")}'`);
		switch (filter.op) {
			case 'in':
				if (values.length) where.push(`${ref} in (${values.join(', ')})`);
				break;
			case 'notIn':
				if (values.length) where.push(`${ref} not in (${values.join(', ')})`);
				break;
			case 'eq':
				if (values.length) where.push(`${ref} = ${values[0]}`);
				break;
			case 'ne':
				if (values.length) where.push(`${ref} <> ${values[0]}`);
				break;
			case 'between':
				if (values.length >= 2) where.push(`${ref} between ${values[0]} and ${values[1]}`);
				break;
			case 'isNull':
				where.push(`${ref} is null`);
				break;
			case 'notNull':
				where.push(`${ref} is not null`);
				break;
			default:
				warnings.push(`Filter "${filter.op}" was not translated to Cube SQL.`);
		}
	}
	// Segments surface as boolean columns on their cube.
	for (const segment of spec.segments ?? []) {
		where.push(`${quote(cubeOf(segment))}.${quote(shortName(segment))} = true`);
	}

	const sql =
		`select\n    ${selects.join(',\n    ')}\n` +
		`from ${cubes.map(quote).join('\n  cross join ')}` +
		(where.length ? `\nwhere ${where.join('\n  and ')}` : '') +
		(groupBy.length ? `\ngroup by ${groupBy.join(', ')}` : '') +
		(query.limit ? `\nlimit ${query.limit}` : '');

	return { sql, columns: outColumns, warnings };
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

/**
 * A client for one Cube deployment.
 *
 * @param {object} config
 * @param {string} config.apiUrl base URL, with or without the /cubejs-api/v1 suffix
 * @param {string} [config.token] JWT for the security context
 * @param {typeof fetch} [config.fetch]
 */
export const createCubeClient = ({ apiUrl, token, fetch: fetchImpl } = {}) => {
	const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
	if (!doFetch) throw new Error('No fetch implementation available for the Cube client');

	const base = String(apiUrl ?? '').replace(/\/+$/, '').replace(/\/cubejs-api\/v1$/, '');
	const headers = { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) };

	const request = async (path, init) => {
		const response = await doFetch(`${base}${path}`, { ...init, headers });
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error(`Cube returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`);
		}
		if (!response.ok || body.error) {
			throw new Error(body.error ?? `Cube request failed (${response.status})`);
		}
		return body;
	};

	return {
		meta: () => request(META_PATH, { method: 'GET' }),

		/**
		 * Run a Cube query. Cube answers 200 with `{error: 'Continue wait'}` while a
		 * query warms, and expects the client to poll — so that is what we do.
		 */
		load: async (query, { retries = 30, waitMs = 700 } = {}) => {
			for (let attempt = 0; attempt < retries; attempt++) {
				const response = await doFetch(`${base}${LOAD_PATH}`, {
					method: 'POST',
					headers,
					body: JSON.stringify({ query })
				});
				const body = await response.json().catch(() => ({ error: 'Cube returned a non-JSON response' }));

				if (body.error === 'Continue wait') {
					await new Promise((r) => setTimeout(r, waitMs));
					continue;
				}
				if (!response.ok || body.error) throw new Error(body.error ?? `Cube query failed (${response.status})`);
				return body;
			}
			throw new Error('Cube query did not complete in time');
		},

		/** The SQL Cube would run — the audit trail behind an explored view. */
		sql: (query) => request(SQL_PATH, { method: 'POST', body: JSON.stringify({ query }) })
	};
};

/**
 * Normalise a Cube load response into the row shape the rest of noodle uses.
 *
 * Cube keys rows by qualified member name, and time dimensions by
 * `Cube.dim.granularity`; the chart encoder and table calculations expect
 * plain columns, and dates as Dates.
 *
 * @param {object} response body of POST /cubejs-api/v1/load
 * @param {object[]} columns from compileCubeQuery
 * @returns {{ rows: object[], annotation: object, sql: string|null }}
 */
/**
 * Parse a Cube timestamp as UTC.
 *
 * Cube sends a truncated month as `"2026-07-01T00:00:00.000"` — ISO-shaped but
 * carrying no timezone. ECMAScript reads a date-*time* string without an offset
 * as LOCAL time, so `new Date(...)` on a UTC+2 machine yields
 * 2026-06-30T22:00:00Z and every month bucket renders one month early. The
 * value Cube sent was correct; the parse localised it.
 *
 * (Note the asymmetry that makes this easy to miss: a date-*only* string like
 * "2026-07-01" is specified as UTC, so short dates look fine while granulated
 * timestamps silently shift.)
 */
const cubeDate = (raw) => {
	if (raw instanceof Date) return raw;
	const s = String(raw);
	// Already carries Z or ±HH:MM — trust it.
	if (/([Zz]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);
	// Bare "YYYY-MM-DDTHH:mm:ss[.sss]" or "YYYY-MM-DD HH:mm:ss" — pin to UTC.
	if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return new Date(`${s.replace(' ', 'T')}Z`);
	return new Date(s);
};

export const normalizeCubeResult = (response, columns) => {
	// `/v1/load` answers with a flat result object for a regular query and wraps
	// it in `results[]` for compare-date-range and blending queries. Both shapes
	// are live in Cube 1.7, so accept either.
	const result = Array.isArray(response?.results) ? (response.results[0] ?? {}) : (response ?? {});
	const data = result.data ?? [];

	const dateAliases = columns.filter((c) => c.dataType === 'date').map((c) => c.alias);
	const numericAliases = columns.filter((c) => c.role === 'measure').map((c) => c.alias);

	const rows = data.map((row) => {
		const next = { ...row };

		for (const alias of dateAliases) {
			// Cube returns both the member and its granulated form; prefer the latter.
			const raw = next[alias] ?? next[alias.split('.').slice(0, 2).join('.')];
			if (raw !== undefined && raw !== null) next[alias] = cubeDate(raw);
		}

		// Cube returns measures as strings to avoid float drift over the wire.
		// Charts and table calculations need numbers.
		for (const alias of numericAliases) {
			const raw = next[alias];
			if (raw === null || raw === undefined || raw === '') {
				next[alias] = null;
			} else if (typeof raw !== 'number') {
				const parsed = Number(raw);
				next[alias] = Number.isFinite(parsed) ? parsed : null;
			}
		}

		return next;
	});

	return { rows, annotation: result.annotation ?? {}, query: result.query ?? null };
};
