<!--
  FlintChart — one chart, described by what the data *means*.

  Evidence's own components are excellent when the form is already decided:
  `<LineChart>` draws a line, `<BarChart>` draws bars, and you tune the rest by
  hand. Flint answers a different question. You hand it the columns and their
  semantic types — `Amount`, `Region`, `Date`, `Percentage` — and it derives the
  layout: axis steps, label rotation, legend placement, when a dense category
  axis has to wrap into facets, how much canvas the whole thing needs. Those are
  the decisions that take the longest to get right by hand and are the first to
  rot when the data changes shape.

  Division of labour, so nothing is decided twice:

    Flint          structure — mark, scales, layout, faceting, overflow
    theme-bridge   ink — the validated palette, chrome, fonts, number formats
    this component data, responsiveness, theme switching, and failing loudly

  The palette is not Flint's. Its `theme_spec` houses are Vega-Lite-only, so the
  ECharts option arrives wearing stock ECharts hues; `theme-bridge.js` re-inks it
  from `evidence.config.yaml`'s validated eight slots before anything is drawn.

  Usage:

    ```sql weekly
    select week, region, revenue from ${saved_weekly_revenue_by_region}
    ```

    <FlintChart
        data={weekly}
        chartType="Line Chart"
        x=week y=revenue series=region
        types={{ week: 'Date', region: 'Region', revenue: 'Amount' }}
        fmt=usd0k
        title="Weekly revenue by region"
        subtitle="USD, excludes cancelled orders"
    />

  Channels beyond x/y/series go through `encodings` — see
  `.claude/skills/flint-chart/references/chart-catalog.md` for which channels
  each of the 37 chart types accepts.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { applyProjectTheme, auditOption } from './flint/theme-bridge.js';
	import { detectMode } from './noodle/engine/theme.js';

	/** Evidence query result, or any array of row objects. */
	export let data = [];

	/** A Flint chart type, exactly as spelled in the catalog: "Line Chart", "Bar Chart", … */
	export let chartType = 'Bar Chart';

	/** The common channels, spelled the way an Evidence page already spells them. */
	export let x = undefined;
	export let y = undefined;
	/** `series` is this project's word for Flint's `color` channel. */
	export let series = undefined;

	/** Everything else — group, size, detail, column, row, y2, open/high/low/close, goal. */
	export let encodings = {};

	/** column → semantic type. The single most load-bearing prop: it drives scales,
	    zero baselines, sort order, colour scheme and formatting. */
	export let types = {};

	/** column → display label, used for axis titles and the legend header. */
	export let labels = {};

	/** Evidence fmt code for the measure: usd0, usd0k, pct1, num0, … */
	export let fmt = undefined;
	/** Per-channel override when x and y carry different units: {x: 'num0', y: 'usd0k'} */
	export let formats = {};

	export let title = undefined;
	export let subtitle = undefined;

	/** Plot height in px. Width is always the container's — charts are responsive. */
	export let height = 320;
	/** Let Flint grow past `height` when the data is dense (its own ceiling still applies). */
	export let grow = true;

	/** Flint template properties: bar corner radius, showLabels, opacity, … */
	export let properties = {};
	/** Flint assembler options. */
	export let options = {};

	/** Set when the page ships a companion DataTable — satisfies the relief rule. */
	export let hasTable = false;

	/** Print the audit findings under the chart instead of only to the console. */
	export let showAudit = false;

	/** How far Flint may grow the canvas vertically past `height` when the data is dense. */
	const MAX_GROWTH = 3;

	let container;
	let chartEl;
	let chart = null;
	let echarts = null;
	let assemble = null;
	let format = (v) => String(v ?? '');

	let mode = 'light';
	let error = null;
	let findings = [];
	let ready = false;
	let width = 0;
	let resizeObserver = null;
	let themeObserver = null;

	/* -------------------------------------------------------------- startup -- */

	onMount(async () => {
		if (!browser) return;
		mode = detectMode();

		try {
			const [ec, flint, formatting] = await Promise.all([
				import('echarts'),
				import('flint-chart'),
				import('@evidence-dev/component-utilities/formatting')
			]);
			echarts = ec;
			assemble = flint.assembleECharts;
			format = (value, code) => {
				if (value === null || value === undefined) return '—';
				try {
					return code ? formatting.fmt(value, code) : formatting.fmt(value, 'num0');
				} catch {
					return String(value);
				}
			};
		} catch (e) {
			error = `Could not load the charting libraries: ${e.message}`;
			return;
		}

		// Width first, then draw: Flint's layout is a function of the canvas it is
		// given, so drawing at a guessed width and resizing after produces a
		// different chart, not the same chart scaled.
		resizeObserver = new ResizeObserver((entries) => {
			const next = Math.round(entries[0]?.contentRect?.width ?? 0);
			if (next > 0 && Math.abs(next - width) > 8) width = next;
		});
		resizeObserver.observe(container);

		// Evidence's theme switcher flips a class on <html>; the canvas cannot
		// inherit CSS, so the chart is recompiled against the new surface.
		themeObserver = new MutationObserver(() => {
			const next = detectMode();
			if (next !== mode) mode = next;
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

		ready = true;
	});

	// Teardown lives here rather than in a function returned from `onMount`: this
	// one is async, and Svelte does not treat a promise's resolved value as a
	// cleanup function — the observers would outlive the component.
	onDestroy(() => {
		resizeObserver?.disconnect();
		themeObserver?.disconnect();
		chart?.dispose();
		chart = null;
	});

	/* --------------------------------------------------------------- render -- */

	/**
	 * Evidence query results are array-like proxies over Arrow vectors, not plain
	 * arrays of plain objects. Flint deep-copies its input with `structuredClone`
	 * as soon as a temporal column is present, and a proxy does not survive that —
	 * it throws "[object Array] could not be cloned" and the chart never draws,
	 * while every chart without a date renders fine.
	 *
	 * So each row is copied into a plain object once, here. BigInts come back from
	 * DuckDB for integer columns and structuredClone *can* carry them, but nothing
	 * downstream expects one — a count that arrives as `10n` breaks arithmetic in
	 * layout — so they are narrowed to numbers at the same time.
	 */
	const toRows = (d) => {
		const raw = Array.isArray(d) ? d : d ? Array.from(d) : [];
		return raw.map((row) => {
			const plain = { ...row };
			for (const key of Object.keys(plain)) {
				if (typeof plain[key] === 'bigint') plain[key] = Number(plain[key]);
			}
			return plain;
		});
	};

	/** `{ x: 'week' }` and `{ x: { field: 'week' } }` are both valid Flint; the
	    shorthand is what a page author writes, so drop empty channels and pass
	    the rest through untouched. */
	const buildEncodings = () => {
		const out = { ...encodings };
		if (x !== undefined) out.x = x;
		if (y !== undefined) out.y = y;
		if (series !== undefined) out.color = series;
		for (const [k, v] of Object.entries(out)) if (v === undefined || v === null || v === '') delete out[k];
		return out;
	};

	const channelFormats = () => {
		const out = { ...formats };
		if (fmt && !out.y) out.y = fmt;
		if (fmt && !out.value) out.value = fmt;
		return out;
	};

	const render = () => {
		if (!ready || !assemble || !echarts || !chartEl || width <= 0) return;

		const rows = toRows(data);
		error = null;
		findings = [];

		if (!rows.length) {
			chart?.clear();
			error = 'No rows. Check the query and any filters above it.';
			return;
		}

		const channels = buildEncodings();
		if (!Object.keys(channels).length) {
			error = 'No encodings. At minimum give this chart an x= and a y=.';
			return;
		}

		const compile = (target) =>
			assemble({
				data: { values: rows },
				semantic_types: types,
				field_display_names: labels,
				chart_spec: {
					chartType,
					title,
					subtitle,
					encodings: channels,
					baseSize: { width: target, height },
					canvasSize: { width: target, height: grow ? Math.round(height * MAX_GROWTH) : height },
					...(Object.keys(properties).length ? { chartProperties: properties } : {})
				},
				...(Object.keys(options).length ? { options } : {})
			});

		let option;
		try {
			// `canvasSize` caps the *plot area*. Flint then adds axis labels, the
			// legend and its canvas buffer outside that, so the canvas it planned
			// (`_width`) routinely exceeds the box we asked for — for a 736px column
			// it planned 786. Drawing that into 736px does not scale it down, it
			// clips: the legend loses its last characters and the final facet panel
			// disappears off the right edge.
			//
			// So the overflow is handed back and the chart recompiled. Each pass can
			// change the layout again (fewer pixels can mean rotated labels, which
			// costs height, not width), which is why this iterates rather than
			// solving once, and why it stops after a few passes and accepts a canvas
			// a hair over the box — a 3px clip is invisible, a wobbling chart is not.
			let target = width;
			option = compile(target);
			for (let pass = 0; pass < 4 && Math.round(option._width ?? target) > width; pass += 1) {
				target = Math.max(200, target - (Math.round(option._width) - width) - 4);
				option = compile(target);
			}
		} catch (e) {
			// A bad chart type or an unfillable channel is an authoring mistake, and
			// this project's whole premise is that those fail visibly rather than
			// rendering something plausible and wrong.
			error = `Flint could not assemble a "${chartType}": ${e.message}`;
			return;
		}

		option._flintTitle = title;
		const fontFamily = getComputedStyle(container).fontFamily;
		applyProjectTheme(option, { mode, font: fontFamily, fmt: format, formats: channelFormats() });
		findings = auditOption(option, { mode, chartType, hasRelief: hasTable });
		if (findings.length && typeof console !== 'undefined') {
			for (const f of findings) console[f.level === 'error' ? 'error' : 'warn'](`[FlintChart:${f.rule}] ${f.message}`);
		}

		// Flint sizes the canvas itself — a dense axis or a facet grid needs more
		// room than `height` asked for, and cramming it back in is what makes
		// hand-built charts illegible. Every position in the option is absolute
		// against that canvas, so the element takes Flint's size rather than the
		// container's; a chart that needs less than the column gets less.
		const canvasWidth = Math.min(Math.round(option._width ?? width), width);
		const canvasHeight = grow ? Math.max(height, Math.round(option._height ?? height)) : height;
		chartEl.style.width = `${canvasWidth}px`;
		chartEl.style.height = `${canvasHeight}px`;

		if (!chart) chart = echarts.init(chartEl, null, { renderer: 'canvas' });
		chart.resize({ width: canvasWidth, height: canvasHeight });
		chart.setOption(option, true);
	};

	$: if (ready && chartEl && width > 0 && (data || chartType || mode || x || y || series || encodings || types)) render();
</script>

<figure class="flint" bind:this={container}>
	{#if title}
		<figcaption class="flint-title">{title}</figcaption>
	{/if}
	{#if subtitle}
		<p class="flint-subtitle">{subtitle}</p>
	{/if}

	<div class="flint-canvas" bind:this={chartEl} style="height: {height}px"></div>

	{#if error}
		<p class="flint-error">{error}</p>
	{/if}

	{#if showAudit && findings.length}
		<ul class="flint-audit">
			{#each findings as f}
				<li class={f.level}><code>{f.rule}</code> {f.message}</li>
			{/each}
		</ul>
	{/if}
</figure>

<style>
	.flint {
		margin: 0 0 1.75rem 0;
		width: 100%;
	}

	/* The headline names the measure; the deck says of whom, when, in what units.
	   Both live in the DOM rather than on the canvas so they stay selectable,
	   searchable and legible to a screen reader. */
	.flint-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--grey-900, #18181b);
		margin: 0 0 0.15rem 0;
		line-height: 1.3;
	}

	.flint-subtitle {
		font-size: 0.8rem;
		color: var(--grey-500, #71717a);
		margin: 0 0 0.6rem 0;
		line-height: 1.35;
	}

	.flint-canvas {
		width: 100%;
	}

	.flint-error {
		font-size: 0.8rem;
		color: var(--negative, #d03b3b);
		border-left: 2px solid var(--negative, #d03b3b);
		padding-left: 0.6rem;
		margin: 0.5rem 0 0 0;
	}

	.flint-audit {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0 0;
		font-size: 0.75rem;
	}

	.flint-audit li {
		color: var(--grey-500, #71717a);
		padding: 0.15rem 0;
	}

	.flint-audit li.error {
		color: var(--negative, #d03b3b);
	}

	.flint-audit code {
		font-size: 0.7rem;
		background: var(--grey-100, #f4f4f5);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		margin-right: 0.3rem;
	}
</style>
