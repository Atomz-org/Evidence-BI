#!/usr/bin/env node
/**
 * Compile the Rill project into a module Evidence can use.
 *
 *   node scripts/build-rill-model.mjs          write components/rill/model.generated.js
 *   node scripts/build-rill-model.mjs --check  exit non-zero if that file is stale
 *
 * Rill reads rill/ directly. The browser cannot: there is no filesystem to
 * resolve read_parquet() against, no YAML parser worth shipping, and no reason
 * to re-parse a static definition on every page load. So the YAML is compiled
 * once, here, and the result is committed.
 *
 * Committing generated code earns its keep only if staleness is caught, so
 * `--check` is a test (tests/t-rill.mjs runs it) rather than a convention.
 *
 * The validation below is the part that matters. Rill's own loader will reject
 * malformed YAML; what it cannot know is whether a measure that advertises
 * `valid_percent_of_total` can actually be summed across a partition. That
 * claim is what draws a "% of total" column, and it is wrong for a distinct
 * count and wrong for a ratio. Getting it wrong is not a crash — it is a
 * plausible number that does not add up, which is worse.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
// Imported rather than restated: the set of d3 specs the renderer can honour is
// exactly the set the project is allowed to declare, and a comment saying so
// would be the first thing to go out of date.
import { D3_SUBSET } from '../components/rill/engine/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RILL = path.join(ROOT, 'rill');
const OUT = path.join(ROOT, 'components/rill/model.generated.js');

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

/* ------------------------------------------------------------------ reading -- */

const readYaml = (file) => {
	try {
		return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
	} catch (e) {
		fail(path.relative(ROOT, file), `unparseable YAML — ${e.message}`);
		return {};
	}
};

const listFiles = (dir, ext) =>
	fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(ext))
				.sort()
				.map((f) => path.join(dir, f))
		: [];

/* ------------------------------------------------------------------ models -- */

/**
 * `read_parquet('data/<source>/<table>/<table>.parquet')` -> `<source>.<table>`.
 *
 * Deliberately rigid. A looser rewrite would quietly accept a path shape that
 * Evidence has no table for, and the failure would surface as a duckdb-wasm
 * "table does not exist" three layers away from the file that caused it.
 */
const PARQUET = /read_parquet\(\s*'data\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.]+)\.parquet'\s*\)/g;

/**
 * Blank out comments while preserving every offset, so the rewrite and the
 * leftover check both see code only. Without this, the file's own explanation
 * of the rewrite rule — which necessarily contains the words it describes —
 * gets rewritten, or trips the check that nothing was missed.
 */
const maskComments = (sql) =>
	sql
		.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const toEvidenceSql = (sql, where) => {
	const code = maskComments(sql);
	const sources = new Set();
	const edits = [];

	for (const match of code.matchAll(PARQUET)) {
		const [text, source, table, file] = match;
		if (file !== table) {
			fail(where, `${text} — expected the file to be named after its directory (${table}.parquet)`);
			continue;
		}
		sources.add(`${source}.${table}`);
		edits.push({ start: match.index, end: match.index + text.length, replacement: `${source}.${table}` });
	}

	let rewritten = sql;
	for (const edit of edits.reverse()) {
		rewritten = rewritten.slice(0, edit.start) + edit.replacement + rewritten.slice(edit.end);
	}

	if (/read_parquet\s*\(/i.test(maskComments(rewritten))) {
		fail(where, "a read_parquet() call did not match data/<source>/<table>/<table>.parquet and cannot run in the browser");
	}
	return { sql: rewritten, sources: [...sources] };
};

const models = {};
for (const file of listFiles(path.join(RILL, 'models'), '.sql')) {
	const name = path.basename(file, '.sql');
	const raw = fs.readFileSync(file, 'utf8');
	const { sql, sources } = toEvidenceSql(raw, `rill/models/${name}.sql`);
	models[name] = { name, file: `rill/models/${name}.sql`, rillSql: raw, sql: sql.trim(), sources };
}

/* ---------------------------------------------------------- metrics views -- */

/**
 * Whether an aggregate expression can be added across a partition.
 *
 * Only the shapes that provably can are accepted: a bare sum/count/min/max, or
 * several of them added together. Anything else — a distinct count, a division,
 * an average — is treated as non-additive. Erring toward refusal is the right
 * bias: refusing an additive measure costs a "% of total" column, while
 * accepting a non-additive one prints parts that exceed their whole.
 */
const ADDITIVE = /^\s*(sum|count|min|max)\s*\(/i;
const isAdditive = (expression) => {
	const expr = String(expression ?? '');
	if (/\bdistinct\b/i.test(expr)) return false;
	// Split on top-level `+` only; a `+` inside a call is part of one term.
	const terms = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < expr.length; i += 1) {
		if (expr[i] === '(') depth += 1;
		else if (expr[i] === ')') depth -= 1;
		else if (expr[i] === '+' && depth === 0) {
			terms.push(expr.slice(start, i));
			start = i + 1;
		} else if ((expr[i] === '/' || expr[i] === '-' || expr[i] === '*') && depth === 0) {
			return false;
		}
	}
	terms.push(expr.slice(start));
	return terms.every((t) => ADDITIVE.test(t));
};

const FORMAT_PRESETS = new Set(['humanize', 'none', 'currency_usd', 'currency_eur', 'percentage', 'interval_ms']);
const GRAINS = ['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

const metricsViews = {};
for (const file of listFiles(path.join(RILL, 'metrics'), '.yaml')) {
	const name = path.basename(file, '.yaml');
	const where = `rill/metrics/${name}.yaml`;
	const doc = readYaml(file);

	if (doc.type !== 'metrics_view') fail(where, `type must be "metrics_view", got ${JSON.stringify(doc.type)}`);
	if (!doc.model || !models[doc.model]) fail(where, `model "${doc.model}" has no rill/models/${doc.model}.sql`);
	if (!doc.timeseries) fail(where, 'no timeseries column — every surface here is time-anchored');
	if (doc.smallest_time_grain && !GRAINS.includes(doc.smallest_time_grain)) {
		fail(where, `smallest_time_grain "${doc.smallest_time_grain}" is not one of ${GRAINS.join(', ')}`);
	}

	const dimensions = (doc.dimensions ?? []).map((d) => {
		if (!d.name) fail(where, 'a dimension has no name');
		if (!d.column && !d.expression) fail(where, `dimension "${d.name}" has neither column nor expression`);
		return {
			name: d.name,
			label: d.display_name ?? d.name,
			description: d.description ?? null,
			// One shape downstream. A dimension is an expression; a `column` is
			// just the expression you get for free.
			expression: d.expression ? String(d.expression).trim() : `"${String(d.column).replace(/"/g, '""')}"`,
			isColumn: !d.expression,
			column: d.column ?? null
		};
	});

	const measures = (doc.measures ?? []).map((m) => {
		if (!m.name) fail(where, 'a measure has no name');
		if (!m.expression) fail(where, `measure "${m.name}" has no expression`);
		if (m.format_preset && !FORMAT_PRESETS.has(m.format_preset)) {
			fail(where, `measure "${m.name}" uses format_preset "${m.format_preset}", which Rill does not define`);
		}
		if (m.format_d3 && !D3_SUBSET.test(m.format_d3)) {
			fail(
				where,
				`measure "${m.name}" uses format_d3 "${m.format_d3}", outside the subset this project renders ` +
					'(see D3_SUBSET in components/rill/engine/format.js) — it would print differently here than in Rill'
			);
		}
		if (m.valid_percent_of_total && !isAdditive(m.expression)) {
			fail(
				where,
				`measure "${m.name}" claims valid_percent_of_total, but \`${String(m.expression).trim()}\` does not add ` +
					'up across a partition — a share of it would print parts that exceed the whole'
			);
		}
		return {
			name: m.name,
			label: m.display_name ?? m.name,
			description: m.description ?? null,
			expression: String(m.expression).trim(),
			formatPreset: m.format_preset ?? 'humanize',
			formatD3: m.format_d3 ?? null,
			percentOfTotal: !!m.valid_percent_of_total,
			lowerIsBetter: !!m.lower_is_better
		};
	});

	const seen = new Set();
	for (const field of [...dimensions, ...measures]) {
		if (seen.has(field.name)) fail(where, `"${field.name}" is defined twice — a name must mean one thing`);
		seen.add(field.name);
	}

	metricsViews[name] = {
		name,
		file: where,
		label: doc.display_name ?? name,
		description: doc.description?.trim() ?? null,
		model: doc.model,
		timeseries: doc.timeseries,
		smallestTimeGrain: doc.smallest_time_grain ?? 'day',
		dimensions,
		measures
	};
}

/* ----------------------------------------------------------------- explores -- */

/**
 * Rill's field selector: `'*'`, a list, or `{ exclude: [...] }` / `{ regex }`.
 */
const selectFields = (selector, available, where, what) => {
	const names = available.map((f) => f.name);
	if (selector === undefined || selector === null || selector === '*') return names;
	if (Array.isArray(selector)) {
		for (const n of selector) if (!names.includes(n)) fail(where, `${what} "${n}" is not in the metrics view`);
		return selector.filter((n) => names.includes(n));
	}
	if (typeof selector === 'object') {
		if (selector.regex) {
			const re = new RegExp(selector.regex);
			return names.filter((n) => re.test(n));
		}
		const excluded = new Set(selector.exclude?.fields ?? selector.exclude ?? []);
		return names.filter((n) => !excluded.has(n));
	}
	fail(where, `${what} selector must be '*', a list, or an object`);
	return names;
};

const explores = {};
for (const file of listFiles(path.join(RILL, 'explores'), '.yaml')) {
	const name = path.basename(file, '.yaml');
	const where = `rill/explores/${name}.yaml`;
	const doc = readYaml(file);

	if (doc.type !== 'explore') fail(where, `type must be "explore", got ${JSON.stringify(doc.type)}`);
	const view = metricsViews[doc.metrics_view];
	if (!view) {
		fail(where, `metrics_view "${doc.metrics_view}" does not exist`);
		continue;
	}

	const dimensions = selectFields(doc.dimensions, view.dimensions, where, 'dimension');
	const measures = selectFields(doc.measures, view.measures, where, 'measure');

	const defaults = doc.defaults ?? {};
	const defaultMeasures = selectFields(defaults.measures, view.measures, where, 'default measure').filter((m) =>
		measures.includes(m)
	);
	const defaultDimensions = selectFields(defaults.dimensions, view.dimensions, where, 'default dimension').filter((d) =>
		dimensions.includes(d)
	);

	if (defaults.comparison_mode && !['none', 'time', 'dimension'].includes(defaults.comparison_mode)) {
		fail(where, `comparison_mode "${defaults.comparison_mode}" is not none, time or dimension`);
	}

	const timeRanges = (doc.time_ranges ?? ['P7D', 'P4W', 'P3M', 'inf']).map((r) => (typeof r === 'string' ? r : r.range));
	if (defaults.time_range && !timeRanges.includes(defaults.time_range)) {
		fail(where, `defaults.time_range "${defaults.time_range}" is not offered in time_ranges`);
	}

	explores[name] = {
		name,
		file: where,
		label: doc.display_name ?? name,
		description: doc.description?.trim() ?? null,
		banner: doc.banner ?? null,
		metricsView: doc.metrics_view,
		dimensions,
		measures,
		timeRanges,
		defaults: {
			measures: defaultMeasures.length ? defaultMeasures : measures.slice(0, 3),
			dimensions: defaultDimensions.length ? defaultDimensions : dimensions.slice(0, 3),
			timeRange: defaults.time_range ?? timeRanges[timeRanges.length - 1],
			comparisonMode: defaults.comparison_mode ?? 'none'
		}
	};
}

/* ------------------------------------------------------------------ canvas -- */

/**
 * The unified board.
 *
 * `canvas/` uses Rill's canvas grammar — rows of items, twelve-column widths,
 * one component key per item — and extends it with three component types Rill
 * does not have. The extensions carry an `x_` prefix so that reading the file
 * tells you which parts are Rill's idea and which are this project's, and so
 * that nobody expects `rill start` to render them. `rill/` next door stays a
 * pure Rill project for exactly that reason.
 */
const RILL_COMPONENTS = new Set([
	'markdown',
	'kpi_grid',
	'line_chart',
	'bar_chart',
	'stacked_bar',
	'area_chart',
	'donut_chart',
	'heatmap',
	'table'
]);

/** This project's additions. Prefixed so the file is self-documenting. */
const EXTENSION_COMPONENTS = new Set(['x_leaderboard', 'x_pivot', 'x_notebook']);

/**
 * Which of the 37 Flint templates draws each canvas component.
 *
 * The mapping is here rather than in the renderer because it is a *definition*
 * decision — "a donut is a pie with up to five slices" is the kind of thing that
 * should be reviewable in a diff, not buried in a switch.
 */
const FLINT_TEMPLATE = {
	line_chart: 'Line Chart',
	area_chart: 'Area Chart',
	bar_chart: 'Bar Chart',
	stacked_bar: 'Stacked Bar Chart',
	donut_chart: 'Pie Chart',
	heatmap: 'Heatmap'
};

/**
 * A column's semantic type, for Flint.
 *
 * Flint derives axis steps, zero baselines, label rotation and faceting from
 * what a column *means*, and a metrics view is the one place in this project
 * that already knows. Inferring it here rather than restating it per chart is
 * the point of having a semantic layer at all: type `revenue` once, and every
 * chart of revenue gets a zero baseline because money has one.
 *
 * A canvas item can override with `types:` where the inference is wrong.
 */
const measureSemanticType = (measure) => {
	if (measure.formatPreset === 'currency_usd' || measure.formatPreset === 'currency_eur') return 'Amount';
	if (measure.formatPreset === 'percentage') return 'Percentage';
	if (measure.formatPreset === 'interval_ms') return 'Duration';
	// A humanized count is the common remaining case; `Count` gives it a zero
	// baseline and integer-friendly ticks, which `Number` does not guarantee.
	return /count|orders|customers|items|users|sessions/i.test(measure.name) ? 'Count' : 'Number';
};

const dimensionSemanticType = (dimension) => {
	const name = dimension.name.toLowerCase();
	if (/(^|_)region($|_)/.test(name)) return 'Region';
	if (/(^|_)(country|country_code)($|_)/.test(name) || name === 'country_code') return 'Country';
	if (/(^|_)(state|province)($|_)/.test(name)) return 'State';
	if (/(^|_)city($|_)/.test(name)) return 'City';
	if (/(^|_)(status|state|stage)($|_)/.test(name)) return 'Status';
	if (/(^|_)(segment|tier|band|size|category|type)($|_)/.test(name)) return 'Category';
	return 'Category';
};

/** The grain a canvas chart buckets time at maps onto a temporal semantic type. */
const GRAIN_SEMANTIC_TYPE = {
	hour: 'DateTime',
	day: 'Date',
	week: 'Date',
	month: 'YearMonth',
	quarter: 'YearQuarter',
	year: 'Year'
};

const canvases = {};
for (const file of listFiles(path.join(ROOT, 'canvas'), '.yaml')) {
	const name = path.basename(file, '.yaml');
	const where = `canvas/${name}.yaml`;
	const doc = readYaml(file);

	if (doc.type !== 'canvas') fail(where, `type must be "canvas", got ${JSON.stringify(doc.type)}`);
	const view = metricsViews[doc.metrics_view];
	if (!view) {
		fail(where, `metrics_view "${doc.metrics_view}" does not exist`);
		continue;
	}

	const measureNames = new Set(view.measures.map((m) => m.name));
	const dimensionNames = new Set(view.dimensions.map((d) => d.name));

	const requireMeasure = (value, what) => {
		if (value && !measureNames.has(value)) fail(where, `${what} "${value}" is not a measure on ${view.name}`);
		return value;
	};
	const requireDimension = (value, what) => {
		if (value && !dimensionNames.has(value)) fail(where, `${what} "${value}" is not a dimension on ${view.name}`);
		return value;
	};

	const rows = (doc.rows ?? []).map((row, rowIndex) => {
		const items = (row.items ?? []).map((item, itemIndex) => {
			const at = `${where} row ${rowIndex + 1} item ${itemIndex + 1}`;
			const keys = Object.keys(item).filter((k) => k !== 'width' && k !== 'height');
			if (keys.length !== 1) {
				fail(at, `an item names exactly one component; found ${keys.length ? keys.join(', ') : 'none'}`);
				return null;
			}
			const [component] = keys;
			const config = item[component] ?? {};

			if (!RILL_COMPONENTS.has(component) && !EXTENSION_COMPONENTS.has(component)) {
				fail(
					at,
					`"${component}" is neither a Rill canvas component nor one of this project's ` +
						`extensions (${[...EXTENSION_COMPONENTS].join(', ')})`
				);
				return null;
			}

			// Referenced fields must exist, whatever the component. A dashboard
			// naming a measure that was renamed in the metrics view should fail at
			// build time, not render an empty tile.
			requireMeasure(config.measure, 'measure');
			requireDimension(config.dimension, 'dimension');
			requireDimension(config.series, 'series');
			requireDimension(config.y, 'y');
			for (const m of config.measures ?? []) requireMeasure(m, 'measure');
			for (const d of config.rows ?? []) requireDimension(d, 'pivot row');
			for (const d of config.columns ?? []) requireDimension(d, 'pivot column');

			if (component === 'bar_chart' && config.orientation && !['vertical', 'horizontal'].includes(config.orientation)) {
				fail(at, `orientation "${config.orientation}" is neither vertical nor horizontal`);
			}
			if (component === 'x_notebook' && !config.sql) fail(at, 'x_notebook needs a sql: block — it is the exhibit');
			if (component === 'x_pivot' && !(config.measures ?? []).length) fail(at, 'x_pivot needs at least one measure');
			if (component === 'kpi_grid' && !(config.measures ?? []).length) fail(at, 'kpi_grid needs measures');

			// Semantic types, resolved here so the renderer never guesses.
			if (component === 'heatmap' && !config.y && !config.grain) {
				fail(at, 'a heatmap needs two categorical axes — give it `y:` as well as `dimension:`, or a `grain:`');
			}

			const types = { ...(config.types ?? {}) };
			for (const measure of view.measures) types[measure.name] ??= measureSemanticType(measure);
			for (const dimension of view.dimensions) types[dimension.name] ??= dimensionSemanticType(dimension);
			types.bucket ??= GRAIN_SEMANTIC_TYPE[config.grain ?? 'day'] ?? 'Date';

			return {
				component,
				extension: EXTENSION_COMPONENTS.has(component),
				width: item.width ?? 12,
				height: item.height ?? row.height ?? null,
				flintTemplate: FLINT_TEMPLATE[component] ?? null,
				types,
				config
			};
		});

		const kept = items.filter(Boolean);
		const width = kept.reduce((n, i) => n + i.width, 0);
		if (width > 12) fail(`${where} row ${rowIndex + 1}`, `widths sum to ${width}; a row is twelve columns`);
		return { height: row.height ?? null, items: kept };
	});

	const timeRanges = (doc.time_ranges ?? ['P7D', 'P4W', 'P3M', 'inf']).map((r) => (typeof r === 'string' ? r : r.range));
	const defaults = doc.defaults ?? {};
	if (defaults.time_range && !timeRanges.includes(defaults.time_range)) {
		fail(where, `defaults.time_range "${defaults.time_range}" is not offered in time_ranges`);
	}

	canvases[name] = {
		name,
		file: where,
		label: doc.display_name ?? name,
		description: doc.description?.trim() ?? null,
		metricsView: doc.metrics_view,
		timeRanges,
		defaults: {
			timeRange: defaults.time_range ?? timeRanges[timeRanges.length - 1],
			comparisonMode: defaults.comparison_mode ?? 'none',
			filters: defaults.filters ?? {}
		},
		gapX: doc.gap_x ?? 12,
		gapY: doc.gap_y ?? 12,
		rows
	};
}

/* ------------------------------------------------------------------- emit -- */

if (!Object.keys(metricsViews).length) fail('rill/metrics', 'no metrics views found');
if (problems.length) {
	console.error(`rill: ${problems.length} problem${problems.length === 1 ? '' : 's'} in the project\n`);
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}

const project = readYaml(path.join(RILL, 'rill.yaml'));
const payload = {
	project: {
		displayName: project.display_name ?? 'Rill',
		description: project.description?.trim() ?? null,
		olapConnector: project.olap_connector ?? 'duckdb'
	},
	models,
	metricsViews,
	explores,
	canvases
};

// A hash of the inputs, not of the output: it answers "was this generated from
// the YAML as it stands", which is the question --check is asking.
const inputs = [
	...listFiles(path.join(RILL, 'models'), '.sql'),
	...listFiles(path.join(RILL, 'metrics'), '.yaml'),
	...listFiles(path.join(RILL, 'explores'), '.yaml'),
	...listFiles(path.join(ROOT, 'canvas'), '.yaml'),
	path.join(RILL, 'rill.yaml')
]
	.filter((f) => fs.existsSync(f))
	.sort();
const hash = crypto.createHash('sha256');
for (const f of inputs) hash.update(path.relative(ROOT, f)).update('\0').update(fs.readFileSync(f));
payload.sourceHash = hash.digest('hex').slice(0, 16);

const module = `/**
 * GENERATED — do not edit. Run \`npm run rill:model\` after changing rill/.
 *
 * The Rill project in rill/ compiled for the browser: read_parquet() paths
 * rewritten to Evidence's registered tables, field selectors resolved, and the
 * additive claims on measures checked. scripts/build-rill-model.mjs is the
 * source of the rules; rill/ is the source of the definitions.
 */

/** @type {import('./engine/metrics.js').RillModel} */
export const RILL = ${JSON.stringify(payload, null, '\t')};

export const { project, models, metricsViews, explores, canvases, sourceHash } = RILL;

export default RILL;
`;

const previous = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (process.argv.includes('--check')) {
	if (previous !== module) {
		console.error(
			previous === null
				? 'rill: components/rill/model.generated.js is missing — run `npm run rill:model`'
				: 'rill: components/rill/model.generated.js is stale — run `npm run rill:model`'
		);
		process.exit(1);
	}
	console.log(`rill: model.generated.js is current (${payload.sourceHash})`);
	process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, module);
console.log(
	`rill: wrote components/rill/model.generated.js — ` +
		`${Object.keys(models).length} model, ${Object.keys(metricsViews).length} metrics view, ` +
		`${Object.keys(explores).length} explore, ${Object.keys(canvases).length} canvas ` +
		`(${payload.sourceHash})`
);
