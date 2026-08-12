/**
 * Integration test for the Flint charting path.
 *
 * The claim under test is narrow and worth pinning down: Flint decides the
 * structure, and `theme-bridge.js` replaces every colour Flint chose with one
 * from this project's validated palette. A chart that quietly kept ECharts'
 * stock hues would still *look* fine, which is exactly why it needs an
 * assertion rather than an eyeball.
 *
 * Rows come from the project's real parquet, not fixtures — the shapes that
 * break layout (a hundred distinct weeks, a region that is null, a measure
 * spanning six orders of magnitude) are properties of the data.
 *
 *   node tests/t-flint.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, '.evidence/template');

const { assembleECharts } = await import('flint-chart');
const { applyProjectTheme, auditOption, CATEGORICAL, SEQUENTIAL, CHROME } = await import(
	path.join(ROOT, 'components/flint/theme-bridge.js')
);

/* ----------------------------------------------------------------- harness -- */

let passed = 0;
const failures = [];

const check = (name, fn) => {
	try {
		fn();
		passed += 1;
	} catch (e) {
		failures.push(`${name}\n    ${e.message}`);
	}
};

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

/* -------------------------------------------------------------------- data -- */

const boot = async () => {
	const duck = await import(
		path.join(ROOT, 'node_modules/@evidence-dev/universal-sql/src/client-duckdb/node.js')
	);
	await duck.initDB();

	const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'static/data/manifest.json'), 'utf8'));
	await duck.setParquetURLs(
		Object.fromEntries(
			Object.entries(manifest.renderedFiles).map(([source, files]) => [
				source,
				files.map((f) => path.join(TEMPLATE, f))
			])
		)
	);

	return async (sql) => {
		const rows = await duck.query(sql);
		return JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
	};
};

const run = await boot();

const weekly = await run(`
    select
        strftime(date_trunc('week', ordered_date), '%Y-%m-%d') as week,
        region,
        sum(order_amount_usd) as revenue
    from dbt_semantic.orders
    where order_status != 'cancelled' and region != 'Guest checkout'
    group by 1, 2
    order by 1, 2
`);

assert(weekly.length > 0, 'no rows from the project parquet — run `npm run sources` first');

const TYPES = { week: 'Date', region: 'Region', revenue: 'Amount' };
const fmt = (v, code) => (code === 'usd0k' ? `$${Math.round(Number(v) / 1000)}k` : String(v));

/** Assemble → theme, the way FlintChart.svelte does it. */
const chart = (chartType, encodings, { mode = 'light', formats = { y: 'usd0k' }, title = 'Test' } = {}) => {
	const option = assembleECharts({
		data: { values: weekly },
		semantic_types: TYPES,
		chart_spec: { chartType, title, encodings, baseSize: { width: 720, height: 320 } }
	});
	option._flintTitle = title;
	return applyProjectTheme(option, { mode, fmt, formats });
};

/** Every colour string anywhere in an option, however deeply nested. */
const coloursIn = (node, found = new Set()) => {
	if (typeof node === 'string') {
		if (/^#[0-9a-fA-F]{6}$/.test(node)) found.add(node.toLowerCase());
	} else if (Array.isArray(node)) {
		node.forEach((n) => coloursIn(n, found));
	} else if (node && typeof node === 'object') {
		Object.values(node).forEach((n) => coloursIn(n, found));
	}
	return found;
};

const ECHARTS_STOCK = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4'];

/* ------------------------------------------------------------------- tests -- */

check('flint assembles a multi-series line chart from real rows', () => {
	const option = chart('Line Chart', { x: 'week', y: 'revenue', color: 'region' });
	assert(option.series.length > 1, `expected several series, got ${option.series.length}`);
	assert(
		option.series.every((s) => s.type === 'line'),
		'every series should be a line'
	);
});

check('no ECharts stock hue survives theming', () => {
	for (const type of ['Line Chart', 'Bar Chart', 'Area Chart', 'Stacked Bar Chart']) {
		const found = coloursIn(chart(type, { x: 'week', y: 'revenue', color: 'region' }));
		const stock = ECHARTS_STOCK.filter((h) => found.has(h));
		assert(stock.length === 0, `${type} still wears ECharts hues: ${stock.join(', ')}`);
	}
});

check('series take palette slots in order, light and dark', () => {
	for (const mode of ['light', 'dark']) {
		const option = chart('Line Chart', { x: 'week', y: 'revenue', color: 'region' }, { mode });
		const palette = CATEGORICAL[mode];
		assert(
			JSON.stringify(option.color) === JSON.stringify(palette),
			`${mode}: option.color is not the ${mode} palette`
		);
		option.series.forEach((s, i) => {
			const expected = palette[i % palette.length];
			assert(
				s.itemStyle?.color === expected,
				`${mode}: series ${i} (${s.name}) is ${s.itemStyle?.color}, expected slot ${i} = ${expected}`
			);
		});
	}
});

check('the same series keeps one hue across facet panels', () => {
	const option = chart('Line Chart', { x: 'week', y: 'revenue', color: 'region', column: 'region' });
	const byName = new Map();
	for (const s of option.series) {
		if (!s.name) continue;
		const seen = byName.get(s.name);
		assert(
			seen === undefined || seen === s.itemStyle?.color,
			`${s.name} is ${s.itemStyle?.color} in one panel and ${seen} in another`
		);
		byName.set(s.name, s.itemStyle?.color);
	}
	assert(byName.size > 1, 'faceting produced only one series — the test proves nothing');
});

check('a legend that names only some of the series is dropped, not kept', () => {
	// Faceting by the same field that colours the chart makes Flint emit a legend
	// with one entry for every panel — a key that mis-labels two thirds of them.
	const option = chart('Line Chart', { x: 'week', y: 'revenue', color: 'region', column: 'region' });
	const names = new Set(option.series.map((s) => s.name).filter(Boolean));
	assert(names.size > 1, 'the fixture produced one series — the test proves nothing');
	assert(
		!option.legend || option.legend.data?.length >= names.size,
		`legend lists ${option.legend?.data?.length} of ${names.size} series`
	);
	const headers = (option.graphic ?? []).filter((g) => g.type === 'text');
	assert(option.legend || headers.length === 0, 'the legend went but its header stayed');
});

check('a complete legend survives', () => {
	const option = chart('Line Chart', { x: 'week', y: 'revenue', color: 'region' });
	const names = new Set(option.series.map((s) => s.name).filter(Boolean));
	assert(option.legend, 'an unfaceted multi-series chart lost its legend');
	assert(option.legend.data.length === names.size, 'the legend no longer matches the series');
});

check('a continuous colour channel uses the sequential ramp, reversed on dark', () => {
	for (const mode of ['light', 'dark']) {
		const option = assembleECharts({
			data: { values: weekly },
			semantic_types: TYPES,
			chart_spec: {
				chartType: 'Heatmap',
				title: 'Heat',
				encodings: { x: 'week', y: 'region', color: 'revenue' },
				baseSize: { width: 720, height: 320 }
			}
		});
		applyProjectTheme(option, { mode, fmt, formats: { y: 'usd0k' } });
		const vm = Array.isArray(option.visualMap) ? option.visualMap[0] : option.visualMap;
		assert(vm, 'heatmap produced no visualMap');
		assert(
			JSON.stringify(vm.inRange.color) === JSON.stringify(SEQUENTIAL[mode]),
			`${mode}: ramp is ${JSON.stringify(vm.inRange.color)}, expected ${JSON.stringify(SEQUENTIAL[mode])}`
		);
	}
});

check('axis chrome follows the surface', () => {
	for (const mode of ['light', 'dark']) {
		const option = chart('Bar Chart', { x: 'region', y: 'revenue' }, { mode });
		const axis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
		assert(axis.axisLine.lineStyle.color === CHROME[mode].axis, `${mode}: axis line colour is wrong`);
		assert(axis.splitLine.lineStyle.color === CHROME[mode].grid, `${mode}: gridline colour is wrong`);
		assert(axis.axisLabel.color === CHROME[mode].muted, `${mode}: axis label colour is wrong`);
		assert(option.backgroundColor === 'transparent', `${mode}: chart paints its own background`);
	}
});

check('the measure axis wears the format it was given', () => {
	const option = chart('Bar Chart', { x: 'region', y: 'revenue' });
	const axis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
	assert(typeof axis.axisLabel.formatter === 'function', 'measure axis has no formatter');
	assert(axis.axisLabel.formatter(1_234_567) === '$1235k', `formatter produced ${axis.axisLabel.formatter(1_234_567)}`);

	// Flint writes its own tooltip formatter, which ECharts prefers over
	// `valueFormatter` — so the hover is only formatted if the bridge replaced it.
	assert(typeof option.tooltip.formatter === 'function', 'tooltip has no formatter');
	const hover = option.tooltip.formatter([{ seriesName: 'EMEA', value: 1_234_567, marker: '' }]);
	assert(hover.includes('$1235k'), `tooltip rendered "${hover}" — the measure is unformatted`);
	assert(!option.tooltip.valueFormatter, 'a dead valueFormatter was left behind');
});

check('tooltips escape series names rather than interpolating them', () => {
	const option = chart('Bar Chart', { x: 'region', y: 'revenue' });
	const hover = option.tooltip.formatter([{ seriesName: '<img src=x onerror=alert(1)>', value: 1000, marker: '' }]);
	assert(!hover.includes('<img'), 'a series name was interpolated into the tooltip as markup');
	assert(hover.includes('&lt;img'), 'the series name was dropped instead of escaped');
});

check('a pie leaves its slices to option.color', () => {
	const option = chart('Pie Chart', { size: 'revenue', color: 'region' });
	const pie = option.series.find((s) => s.type === 'pie');
	assert(pie, 'no pie series');
	assert(!pie.itemStyle?.color, 'the pie series was inked as a whole — its slices would collapse to one hue');
	assert(JSON.stringify(option.color) === JSON.stringify(CATEGORICAL.light), 'slices would not use the palette');
});

check('the audit catches an unformatted, untitled chart', () => {
	const option = assembleECharts({
		data: { values: weekly },
		semantic_types: TYPES,
		chart_spec: { chartType: 'Bar Chart', encodings: { x: 'region', y: 'revenue' }, baseSize: { width: 720, height: 320 } }
	});
	applyProjectTheme(option, { mode: 'light', fmt, formats: {} });
	const rules = auditOption(option, { mode: 'light', chartType: 'Bar Chart' }).map((f) => f.rule);
	assert(rules.includes('unformatted-measure'), `expected unformatted-measure, got ${rules.join(', ') || 'nothing'}`);
	assert(rules.includes('missing-title'), `expected missing-title, got ${rules.join(', ') || 'nothing'}`);
});

check('the audit stays quiet on a well-formed chart', () => {
	const option = chart('Line Chart', { x: 'week', y: 'revenue', color: 'region' });
	const findings = auditOption(option, { mode: 'light', chartType: 'Line Chart', hasRelief: true });
	assert(findings.length === 0, `expected silence, got: ${findings.map((f) => f.rule).join(', ')}`);
});

check('the audit refuses to cycle hues', () => {
	// Nine synthetic series against an eight-slot palette.
	const many = [];
	for (let i = 0; i < 9; i += 1) {
		for (const week of ['2026-01-05', '2026-01-12']) many.push({ week, region: `R${i}`, revenue: 1000 * (i + 1) });
	}
	const option = assembleECharts({
		data: { values: many },
		semantic_types: TYPES,
		chart_spec: { chartType: 'Line Chart', title: 'Nine', encodings: { x: 'week', y: 'revenue', color: 'region' }, baseSize: { width: 720, height: 320 } }
	});
	option._flintTitle = 'Nine';
	applyProjectTheme(option, { mode: 'light', fmt, formats: { y: 'usd0k' } });
	const rules = auditOption(option, { mode: 'light', chartType: 'Line Chart' }).map((f) => f.rule);
	assert(rules.includes('palette-exhausted'), `expected palette-exhausted, got ${rules.join(', ') || 'nothing'}`);
});

/* ------------------------------------------------------------------ report -- */

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`\n  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
