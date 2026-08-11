/**
 * The dashboard model — many views on one page.
 *
 * noodle answers one question at a time. A dashboard is the composition: several
 * views sharing a filter context, arranged, saved, and published back to
 * Evidence markdown so the ad-hoc thing becomes governed code.
 *
 * Three ideas carry the whole file.
 *
 *   1. **A tile is a spec.** Nothing more. Anything noodle can compile a tile can
 *      show, and the tile editor is noodle itself.
 *   2. **Filter context composes at query time, never in the tile.** Page filters
 *      and the cross-filter are merged into a copy of the tile's spec when it
 *      runs. The tile stays the thing its author drew, so clearing the page
 *      restores it exactly — and a saved dashboard never carries someone's
 *      transient click.
 *   3. **The exit is source.** `dashboardToMarkdown` emits a complete Evidence
 *      page — frontmatter, inputs, queries, components — not a screenshot.
 */

import { compile, resolvePrimary } from './compile.js';
import { planJoins } from './catalog.js';
import { allPills, pillLabel } from './spec.js';
import { toEvidenceMarkdown } from './export.js';
import { FILTER_OPS } from './sql.js';

/** Bumped when the saved shape changes in a way older files cannot satisfy. */
export const DASHBOARD_VERSION = 1;

/**
 * Tile widths, in twelfths — the grid every layout is expressed in.
 *
 * This list is not just the width picker's options: `deserializeDashboard`
 * rejects anything outside it and falls back to a half-width tile. So a width
 * that can be produced but not chosen is a layout that silently rearranges
 * itself the first time it is reopened. 9 is here because 3+9 is the shape of a
 * headline beside a trend, which is what the auto-build reaches for.
 */
export const TILE_WIDTHS = [3, 4, 6, 8, 9, 12];
/** Tile heights in pixels. A chart's height is a design decision, not a row count. */
export const TILE_HEIGHTS = [180, 260, 340, 460];

let tileCounter = 0;
let importCounter = 0;

/**
 * @param {object} [options]
 * @returns {import('./types.js').Dashboard}
 */
export const emptyDashboard = ({ title, subtitle, mode } = {}) => ({
	version: DASHBOARD_VERSION,
	title: title ?? 'Untitled dashboard',
	subtitle: subtitle ?? '',
	/**
	 * `dashboard` is scanned and operated; `report` is circulated and archived.
	 * The distinction is not cosmetic — it changes the page width, the print
	 * behaviour, and what `dashboardToMarkdown` emits.
	 */
	mode: mode ?? 'dashboard',
	tiles: [],
	filters: [],
	crossFilter: null
});

/**
 * @param {object} options
 * @returns {import('./types.js').Tile}
 */
export const makeTile = ({ spec, title = '', w = 6, h = 260, mark = 'auto' } = {}) => ({
	id: `tile_${++tileCounter}`,
	title,
	spec: spec ? { ...spec, mark: spec.mark ?? mark } : null,
	w,
	h
});

/** Reset the tile counter — tests only, so ids are deterministic. */
export const __resetTileCounter = () => {
	tileCounter = 0;
	importCounter = 0;
};

/* ------------------------------------------------------------------ tiles -- */

export const addTile = (dashboard, tile) => ({ ...dashboard, tiles: [...dashboard.tiles, tile] });

export const removeTile = (dashboard, tileId) => ({
	...dashboard,
	tiles: dashboard.tiles.filter((t) => t.id !== tileId),
	// A cross-filter is owned by the tile that raised it. Delete the tile and the
	// filter has no author, so it goes too — otherwise the page stays filtered by
	// something the reader can no longer see or undo.
	crossFilter: dashboard.crossFilter?.tileId === tileId ? null : dashboard.crossFilter
});

export const updateTile = (dashboard, tileId, patch) => ({
	...dashboard,
	tiles: dashboard.tiles.map((t) => (t.id === tileId ? { ...t, ...patch } : t))
});

export const duplicateTile = (dashboard, tileId) => {
	const index = dashboard.tiles.findIndex((t) => t.id === tileId);
	if (index < 0) return dashboard;
	const source = dashboard.tiles[index];
	const copy = {
		...makeTile({ w: source.w, h: source.h }),
		title: source.title ? `${source.title} (copy)` : '',
		spec: rekeySpec(source.spec)
	};
	const tiles = [...dashboard.tiles];
	tiles.splice(index + 1, 0, copy);
	return { ...dashboard, tiles };
};

/** Move a tile one position earlier or later in the flow. */
export const moveTile = (dashboard, tileId, delta) => {
	const from = dashboard.tiles.findIndex((t) => t.id === tileId);
	const to = from + delta;
	if (from < 0 || to < 0 || to >= dashboard.tiles.length) return dashboard;
	const tiles = [...dashboard.tiles];
	const [tile] = tiles.splice(from, 1);
	tiles.splice(to, 0, tile);
	return { ...dashboard, tiles };
};

/**
 * Group tiles into rows of at most twelve columns.
 *
 * The layout is a flow, not a free canvas. Tiles keep their order and wrap, which
 * is what makes the same dashboard legible on a laptop, on a phone and on paper —
 * an absolutely-positioned canvas has to be re-laid-out by hand for each.
 */
export const layoutRows = (tiles, cols = 12) => {
	const rows = [];
	let row = [];
	let used = 0;
	for (const tile of tiles) {
		const w = Math.min(Math.max(tile.w ?? 6, 1), cols);
		if (used + w > cols && row.length) {
			rows.push(row);
			row = [];
			used = 0;
		}
		row.push(tile);
		used += w;
	}
	if (row.length) rows.push(row);
	return rows;
};

/* ---------------------------------------------------------------- filters -- */

const filterKey = (f) => `${f.fieldId}|${f.op}|${JSON.stringify(f.values ?? [])}`;

/**
 * Combine filter sources into one list.
 *
 * They intersect — a page filter narrows a tile that already filters itself,
 * it does not replace it. That can legitimately empty a tile (page says East,
 * tile says West), and an empty tile is the honest answer to that combination.
 * Identical filters are collapsed so the same predicate is never emitted twice.
 */
export const mergeFilters = (...lists) => {
	const seen = new Set();
	const out = [];
	for (const filter of lists.flat().filter(Boolean)) {
		const key = filterKey(filter);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(filter);
	}
	return out;
};

/**
 * Whether a filter on `fieldId` can reach a tile at all.
 *
 * A dashboard mixes tiles built on different tables. A cross-filter raised on a
 * customer attribute is meaningless to a tile whose source has no path to the
 * customer table, and the compiler will drop it with a warning. Knowing that in
 * advance is what lets the tile say "not filtered" instead of quietly showing
 * unfiltered numbers next to filtered ones — the failure mode that makes a
 * dashboard lie.
 */
export const filterReaches = (catalog, spec, fieldId) => {
	const field = catalog?.byId?.[fieldId];
	if (!field || !spec) return false;
	const primary = resolvePrimary(catalog, spec);
	if (!primary) return false;
	if (field.table === primary) return true;
	return planJoins(catalog, primary, [fieldId]).unreachable.length === 0;
};

/**
 * The spec a tile actually runs: its own, plus the page's filter context.
 *
 * @param {object} dashboard
 * @param {object} tile
 * @param {object} [catalog] when given, filters the tile cannot reach are dropped
 *   here rather than inside the compiler, so the caller can report them
 * @returns {{ spec: object|null, applied: object[], ignored: object[] }}
 */
export const tileContext = (dashboard, tile, catalog = null) => {
	if (!tile?.spec) return { spec: null, applied: [], ignored: [] };

	const context = [...(dashboard.filters ?? [])];
	const cross = dashboard.crossFilter;
	// The tile that raised a cross-filter is not filtered by it. It shows the
	// whole distribution with the selection highlighted, which is the only way to
	// keep the click reversible — filter the source and the other bars vanish
	// along with any way back.
	if (cross && cross.tileId !== tile.id && (cross.values ?? []).length) {
		context.push({ fieldId: cross.fieldId, role: 'dimension', op: 'in', values: cross.values, cross: true });
	}

	const applied = [];
	const ignored = [];
	for (const filter of context) {
		(catalog && !filterReaches(catalog, tile.spec, filter.fieldId) ? ignored : applied).push(filter);
	}

	return {
		spec: applied.length
			? { ...tile.spec, filters: mergeFilters(tile.spec.filters ?? [], applied) }
			: tile.spec,
		applied,
		ignored
	};
};

/** Set or clear the cross-filter. Clicking the same value twice clears it. */
export const toggleCrossFilter = (dashboard, next) => {
	const current = dashboard.crossFilter;
	const same =
		current &&
		next &&
		current.tileId === next.tileId &&
		current.fieldId === next.fieldId &&
		JSON.stringify(current.values) === JSON.stringify(next.values);
	return { ...dashboard, crossFilter: same ? null : next };
};

export const addPageFilter = (dashboard, filter) => {
	const existing = (dashboard.filters ?? []).findIndex(
		(f) => f.fieldId === filter.fieldId && f.op === filter.op
	);
	const filters = [...(dashboard.filters ?? [])];
	// A slicer is one control. Re-selecting on the same field replaces the
	// selection rather than intersecting with the last one.
	if (existing >= 0) filters[existing] = filter;
	else filters.push(filter);
	return { ...dashboard, filters };
};

export const removePageFilter = (dashboard, index) => ({
	...dashboard,
	filters: (dashboard.filters ?? []).filter((_, i) => i !== index)
});

/** How a filter chip reads on screen. */
export const describeFilter = (catalog, filter) => {
	const field = catalog?.byId?.[filter.fieldId];
	const name = field?.name ?? filter.fieldId;
	const op = FILTER_OPS[filter.op]?.label ?? filter.op;
	const values = (filter.values ?? []).map((v) => formatFilterValue(v));
	if (!values.length) return `${name} ${op}`;
	const shown = values.length > 3 ? `${values.slice(0, 3).join(', ')} +${values.length - 3}` : values.join(', ');
	return `${name} ${op} ${shown}`;
};

const formatFilterValue = (value) => {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	// Dates survive a save as ISO strings; showing the timestamp tail is noise.
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value)) return value.slice(0, 10);
	return String(value);
};

/* ------------------------------------------------------------ persistence -- */

/**
 * Give every pill in a spec a fresh key.
 *
 * Pill keys come from a counter that restarts with the page. A dashboard loaded
 * from storage carries keys minted in an earlier session, and the counter knows
 * nothing about them — so a newly dragged pill can be handed a key that a saved
 * pill already holds, and removing one would remove both. Imported pills get
 * their own namespace instead of trying to advance a counter they cannot see.
 */
export const rekeySpec = (spec) => {
	if (!spec) return spec;
	const remap = (pill) => (pill ? { ...pill, key: `k_${++importCounter}` } : pill);
	return {
		...spec,
		columns: (spec.columns ?? []).map(remap),
		rows: (spec.rows ?? []).map(remap),
		detail: (spec.detail ?? []).map(remap),
		tooltip: (spec.tooltip ?? []).map(remap),
		color: remap(spec.color),
		size: remap(spec.size),
		label: remap(spec.label)
	};
};

export const serializeDashboard = (dashboard) =>
	JSON.stringify(
		{
			version: DASHBOARD_VERSION,
			title: dashboard.title,
			subtitle: dashboard.subtitle,
			mode: dashboard.mode,
			filters: dashboard.filters ?? [],
			// The cross-filter is a gesture, not a definition. It is deliberately not
			// saved: reopening a dashboard should show the dashboard, not the last
			// thing somebody clicked on it.
			tiles: (dashboard.tiles ?? []).map((t) => ({ id: t.id, title: t.title, w: t.w, h: t.h, spec: t.spec }))
		},
		null,
		2
	);

/**
 * @param {string|object} input
 * @returns {object} a dashboard
 * @throws if the payload is not a dashboard this build understands
 */
export const deserializeDashboard = (input) => {
	const raw = typeof input === 'string' ? JSON.parse(input) : input;
	if (!raw || typeof raw !== 'object') throw new Error('Not a dashboard file.');
	if (raw.version !== DASHBOARD_VERSION) {
		throw new Error(
			`This file was saved by version ${raw.version ?? 'unknown'}; this build reads version ${DASHBOARD_VERSION}.`
		);
	}
	if (!Array.isArray(raw.tiles)) throw new Error('Dashboard has no tiles array.');

	return {
		...emptyDashboard({ title: raw.title, subtitle: raw.subtitle, mode: raw.mode }),
		filters: Array.isArray(raw.filters) ? raw.filters : [],
		tiles: raw.tiles.map((t) => ({
			id: `tile_${++tileCounter}`,
			title: t.title ?? '',
			w: TILE_WIDTHS.includes(t.w) ? t.w : 6,
			h: TILE_HEIGHTS.includes(t.h) ? t.h : 260,
			spec: rekeySpec(t.spec)
		}))
	};
};

/* -------------------------------------------------------------- published -- */

/**
 * A sentinel that survives compilation as a SQL string literal and can then be
 * swapped for an Evidence input reference.
 *
 * Templating the WHERE clause by hand would mean re-implementing the compiler's
 * filter rendering and keeping the two in step. Compiling a unique literal and
 * replacing it afterwards means the published SQL is the SQL that ran, with one
 * substitution — and the substitution is exact, because nothing else in the
 * query can contain this string.
 */
const sentinel = (i) => `__evidence_input_${i}__`;

/** Filters that become a control on the published page rather than a constant. */
const isTemplatable = (filter) =>
	(filter.op === 'in' || filter.op === 'eq') && filter.role !== 'measure' && (filter.values ?? []).length > 0;

const inputName = (catalog, filter, index) => {
	const column = catalog?.byId?.[filter.fieldId]?.column ?? `f${index}`;
	return `${String(column).replace(/[^A-Za-z0-9_]/g, '_')}_${index}`.replace(/^_+/, '');
};

const queryName = (tile, index) => {
	const base = String(tile.title || `tile_${index + 1}`)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return `${base || 'tile'}_${index + 1}`;
};

const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;');

/**
 * Emit a complete Evidence page for a dashboard.
 *
 * This is the whole point of building a dashboard in a BI-as-code project: the
 * thing you assembled by clicking leaves as source that can be reviewed,
 * diffed and deployed. Page filters leave as real Evidence inputs, so the
 * published page is interactive rather than a frozen snapshot of one selection.
 *
 * @param {object} args
 * @param {object} args.catalog
 * @param {object} args.dashboard
 * @param {(catalog: object, spec: object) => object} [args.compileSpec]
 * @param {string} [args.generatedOn] ISO date, injected so output is deterministic
 * @returns {string}
 */
export const dashboardToMarkdown = ({ catalog, dashboard, compileSpec = compile, generatedOn = null }) => {
	const report = dashboard.mode === 'report';
	const templated = (dashboard.filters ?? []).filter(isTemplatable);

	const lines = [
		'---',
		`title: ${dashboard.title || 'Untitled'}`,
		...(dashboard.subtitle ? [`description: ${dashboard.subtitle}`] : []),
		...(report ? [] : ['full_width: true']),
		'---',
		''
	];

	lines.push(
		'<!--',
		`  Generated by the noodle Studio${generatedOn ? ` on ${generatedOn}` : ''}.`,
		'',
		'  These are ad-hoc aggregates: the numbers carry no metric definition. If one',
		'  of them matters, define it in dbt first and rebuild this page against the',
		'  metric — see /metrics.',
		'-->',
		''
	);

	if (dashboard.subtitle) lines.push(dashboard.subtitle, '');

	if (report) {
		lines.push(
			'<Alert status="info">',
			'',
			`**Basis of preparation.** Ad-hoc analysis${
				templated.length ? `, filtered by ${templated.map((f) => describeFilter(catalog, f)).join('; ')}` : ''
			}. Figures are unaudited and carry no metric definition.`,
			'',
			'</Alert>',
			''
		);
	}

	/* ------------------------------------------------------- page filters -- */
	const substitutions = [];
	if (templated.length) {
		lines.push('## Filters', '');
		templated.forEach((filter, index) => {
			const field = catalog?.byId?.[filter.fieldId];
			if (!field) return;
			const name = inputName(catalog, filter, index);
			const multiple = filter.op === 'in' && (filter.values ?? []).length !== 1;

			lines.push(
				`\`\`\`sql ${name}_options`,
				`select distinct "${field.column}" as value`,
				`from "${String(field.table).split('.').join('"."')}"`,
				'where value is not null',
				'order by 1',
				'```',
				''
			);
			lines.push(
				`<Dropdown name=${name} data={${name}_options} value=value` +
					` title="${escapeAttr(field.name ?? field.column)}"` +
					(multiple ? ' multiple=true' : '') +
					(filter.values?.length === 1 ? ` defaultValue="${escapeAttr(String(filter.values[0]))}"` : '') +
					' />',
				''
			);

			substitutions.push({
				filter,
				marker: sentinel(index),
				// A multi-select interpolates as a quoted, comma-separated list, so it
				// replaces the whole parenthesised literal list; a single select
				// interpolates as a bare value and keeps its quotes.
				replacement: multiple ? `\${inputs.${name}.value}` : `'\${inputs.${name}.value}'`,
				multiple
			});
		});
	}

	const constantFilters = (dashboard.filters ?? []).filter((f) => !isTemplatable(f));

	/* --------------------------------------------------------------- tiles -- */
	const rows = layoutRows(dashboard.tiles ?? []);
	let exhibit = 0;

	for (const row of rows) {
		const rendered = [];

		for (const tile of row) {
			const index = dashboard.tiles.indexOf(tile);
			if (!tile.spec || !allPills(tile.spec).length) continue;

			// Compile with the page's filters in place — templatable ones carrying a
			// sentinel value, everything else carrying its real value.
			const filters = mergeFilters(
				tile.spec.filters ?? [],
				substitutions.map((s) => ({ ...s.filter, op: s.multiple ? 'in' : 'eq', values: [s.marker] })),
				constantFilters
			);
			const compiled = compileSpec(catalog, { ...tile.spec, filters });
			if (!compiled?.sql) continue;

			let sql = compiled.sql;
			for (const s of substitutions) sql = applySubstitution(sql, s);

			const name = queryName(tile, index);
			const mark = tile.spec.mark && tile.spec.mark !== 'auto' ? tile.spec.mark : 'bar';
			const body = toEvidenceMarkdown({
				catalog,
				spec: tile.spec,
				compiled: { ...compiled, sql },
				mark,
				queryName: name
			});
			if (body) rendered.push({ tile, body, name });
		}

		if (!rendered.length) continue;

		if (report) {
			// A report is read in sequence and cited by exhibit, so tiles become
			// numbered sections rather than a grid.
			for (const { tile, body } of rendered) {
				exhibit++;
				lines.push(`## Exhibit ${exhibit} — ${tile.title || 'Untitled view'}`, '', body, '');
				lines.push(`<span class="source-line">Source: ${sourceLine(catalog, tile.spec)}</span>`, '');
			}
		} else if (rendered.length === 1) {
			const { tile, body } = rendered[0];
			if (tile.title) lines.push(`## ${tile.title}`, '');
			lines.push(body, '');
		} else {
			// The published grid is equal-width: Evidence's Grid lays out N columns
			// and does not carry per-child spans, so unequal tile widths collapse to
			// "how many sat in this row". Said plainly here rather than silently.
			lines.push(`<Grid cols=${rendered.length}>`, '');
			for (const { tile, body } of rendered) {
				lines.push('<div>', '');
				if (tile.title) lines.push(`**${tile.title}**`, '');
				lines.push(body, '', '</div>', '');
			}
			lines.push('</Grid>', '');
		}
	}

	if (report) lines.push('<LastRefreshed prerendered=true/>', '');

	return lines.join('\n');
};

/**
 * Replace a compiled sentinel literal with an Evidence input reference.
 *
 * For a multi-select the whole `in ('__sentinel__')` list is replaced, because
 * `${inputs.x.value}` already expands to a comma-separated quoted list; for a
 * single value only the literal is replaced, since the template keeps the quotes.
 */
const applySubstitution = (sql, { marker, replacement, multiple }) =>
	multiple
		? sql.split(`('${marker}')`).join(`(${replacement})`)
		: sql.split(`'${marker}'`).join(replacement);

const sourceLine = (catalog, spec) => {
	const primary = resolvePrimary(catalog, spec);
	const measures = allPills(spec)
		.filter((p) => p.role === 'measure')
		.map((p) => pillLabel(catalog, p));
	return [primary, measures.join(', ')].filter(Boolean).join(' · ');
};
