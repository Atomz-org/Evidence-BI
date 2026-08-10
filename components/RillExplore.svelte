<!--
  RillExplore — a Rill explore dashboard, rendered by Evidence.

  Rill's explore is a particular way of asking "what moved": a window of time, the
  window before it, and every dimension ranked inside both. Four things carry
  that, and all four are here.

    * A time range anchored to the newest row, with the window before it.
    * Measure cards that show the value and the change together, because a
      number without its comparison is not an answer.
    * Dimension leaderboards, ranked, where clicking a value filters everything.
    * Expanding a measure into a time series split by a dimension.

  What is *not* here is a Rill server. The definitions come from rill/ through
  scripts/build-rill-model.mjs and compile to DuckDB, so the page keeps working
  with nothing running and deploys as static files. The measures still come from
  one place: `rill start` on the same directory renders the same dashboard from
  the same YAML.

  The read-only SQL drawer on each panel is deliberate, and it is the one place
  this page departs from the project's "every exhibit opens" rule. LiveQuery
  makes a *report* editable, because a report is an argument and the reader
  should be able to check it. A governed measure is the opposite kind of object:
  its whole value is that it means one thing everywhere. So the SQL is visible on
  every panel and editable on none of them — and the escape hatch at the bottom
  is a real one, where an edited query is plainly the reader's own.
-->
<script>
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';

	import LiveQuery from './LiveQuery.svelte';
	import { RILL } from './rill/model.generated.js';
	import {
		boundsSql,
		catalogFromMetricsView,
		createViewSql,
		detailSql,
		leaderboardSql,
		seriesSql,
		totalsSql,
		viewName
	} from './rill/engine/metrics.js';
	import { formatUtcDate, rangeLabel, resolveRange } from './rill/engine/timerange.js';
	import {
		delta,
		formatDelta,
		formatInstant,
		formatMeasure,
		formatPercent,
		isFavourable,
		percentOfTotal
	} from './rill/engine/format.js';
	import { CATEGORICAL, CHROME, detectMode } from './noodle/engine/theme.js';
	import { createSequencer } from './noodle/engine/runner.js';

	/** Which explore in rill/explores to render. */
	export let explore = Object.keys(RILL.explores)[0];

	/** Rows in each leaderboard before it scrolls. */
	export let leaderboardRows = 8;

	/** Show the escape hatch that hands the window to LiveQuery. */
	export let escapeHatch = true;

	const config = RILL.explores[explore];
	const view = config ? RILL.metricsViews[config.metricsView] : null;

	const measureBy = Object.fromEntries((view?.measures ?? []).map((m) => [m.name, m]));
	const dimensionBy = Object.fromEntries((view?.dimensions ?? []).map((d) => [d.name, d]));

	/* ------------------------------------------------------------------ state -- */

	let rangeToken = config?.defaults.timeRange ?? 'inf';
	let comparisonOn = config?.defaults.comparisonMode === 'time';
	let activeMeasure = config?.defaults.measures[0] ?? view?.measures[0]?.name;
	let shownMeasures = config?.defaults.measures ?? [];
	let shownDimensions = config?.defaults.dimensions ?? [];
	/** @type {Record<string, {mode:'include'|'exclude', values:string[]}>} */
	let filters = {};
	/** Which dimension the chart is split by, if any. */
	let expanded = null;

	let bounds = null;
	let totals = null;
	let series = [];
	let boards = {};
	let detail = [];
	let sqlShown = {};
	let error = null;
	let loading = true;
	let mode = 'light';

	let duck = null;
	let echarts = null;
	let chartEl;
	let chart = null;
	const sequencer = createSequencer();

	$: range = bounds ? resolveRange(rangeToken, bounds, view?.smallestTimeGrain) : null;
	$: comparing = comparisonOn && !!range?.comparison;
	$: activeMeasureDef = measureBy[activeMeasure];
	$: filterCount = Object.values(filters).reduce((n, f) => n + (f?.values?.length ?? 0), 0);

	/* ------------------------------------------------------------------- data -- */

	const plain = (rows) =>
		JSON.parse(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));

	const run = async (sql) => plain(await duck.query(sql));

	/**
	 * Ask for everything the current state implies.
	 *
	 * One function rather than a query per reactive statement: the panels have to
	 * agree with each other, and a leaderboard that has caught up with a new filter
	 * while the headline has not is worse than a slower page.
	 */
	const refresh = async () => {
		if (!duck || !view || !range) return;
		loading = true;
		error = null;

		const result = await sequencer.run(async () => {
			const scope = { range: comparing ? range : { ...range, comparison: null }, filters };

			const totalsQuery = totalsSql(view, { ...scope, measures: shownMeasures });
			const seriesQuery = seriesSql(view, { ...scope, measures: [activeMeasure] });

			const [totalRows, seriesRows] = await Promise.all([run(totalsQuery), run(seriesQuery)]);

			const boardRows = {};
			await Promise.all(
				shownDimensions.map(async (name) => {
					const sql = leaderboardSql(view, {
						dimension: name,
						measure: activeMeasure,
						...scope,
						limit: 60
					});
					boardRows[name] = { sql, rows: sql ? await run(sql) : [] };
				})
			);

			let detailRows = [];
			let detailQuery = null;
			if (expanded) {
				const top = (boardRows[expanded]?.rows ?? []).slice(0, 6).map((r) => r.value);
				detailQuery = detailSql(view, {
					dimension: expanded,
					measure: activeMeasure,
					...scope,
					values: top
				});
				if (detailQuery) detailRows = await run(detailQuery);
			}

			return {
				totals: totalRows,
				totalsQuery,
				series: seriesRows,
				seriesQuery,
				boards: boardRows,
				detail: detailRows,
				detailQuery
			};
		});

		if (!result) return; // superseded by a newer state
		totals = result.totals;
		series = result.series;
		boards = result.boards;
		detail = result.detail;
		queries = { totals: result.totalsQuery, series: result.seriesQuery, detail: result.detailQuery };
		loading = false;
	};

	let queries = {};

	onMount(async () => {
		if (!browser || !view) return;
		mode = detectMode();
		try {
			const [d, ec] = await Promise.all([
				import('@evidence-dev/universal-sql/client-duckdb'),
				import('echarts')
			]);
			duck = d;
			echarts = ec;
			// The metrics view becomes one relation, once. Everything below reads it,
			// and so does a Noodle worksheet pointed at the same explore.
			await duck.query(createViewSql(view, RILL.models));
			const [b] = plain(await duck.query(boundsSql(view)));
			bounds = { min: new Date(b.lo), max: new Date(b.hi), rows: Number(b.rows) };
			await refresh();
		} catch (e) {
			error = String(e?.message ?? e);
			loading = false;
		}
	});

	// Any state change re-asks. Collected into an array rather than written as a
	// comma expression: `(a, b, expanded)` evaluates to `expanded`, so the guard
	// was false — and the dashboard frozen — whenever nothing was expanded.
	$: inputs = [rangeToken, comparing, activeMeasure, shownMeasures, shownDimensions, filters, expanded];
	$: if (duck && bounds && inputs) refresh();

	/* ----------------------------------------------------------------- actions -- */

	const toggleFilter = (dimension, value, mode_ = 'include') => {
		const existing = filters[dimension];
		const values = new Set(existing?.mode === mode_ ? existing.values : []);
		if (values.has(value)) values.delete(value);
		else values.add(value);

		filters = values.size
			? { ...filters, [dimension]: { mode: mode_, values: [...values] } }
			: Object.fromEntries(Object.entries(filters).filter(([k]) => k !== dimension));
	};

	const clearFilters = () => {
		filters = {};
	};

	/** Passed `active` for the same reason `card` takes its rows — see above. */
	const isFiltered = (active, dimension, value) => active[dimension]?.values.includes(value) ?? false;

	/* ------------------------------------------------------------------ chart -- */

	/**
	 * Align the comparison series with the current one by bucket *index*.
	 *
	 * Not by timestamp: the two windows sit at different instants, and a calendar
	 * offset is not a fixed number of milliseconds, so shifting one onto the other
	 * in SQL would drift across a month boundary. Index alignment is exact by
	 * construction, and the tooltip prints both real dates so nothing is hidden.
	 */
	const chartOption = () => {
		const chrome = CHROME[mode];
		const palette = CATEGORICAL[mode];
		const measure = activeMeasureDef;
		const fmt = (v) => formatMeasure(v, measure, { compact: true });

		if (expanded && detail.length) {
			const buckets = [...new Set(detail.map((r) => r.bucket))].sort((a, b) => a - b);
			const index = new Map(buckets.map((b, i) => [b, i]));
			const names = [...new Set(detail.map((r) => r.value))];
			const seriesData = names.map((name, i) => {
				const values = new Array(buckets.length).fill(null);
				for (const row of detail) if (row.value === name) values[index.get(row.bucket)] = row[measure.name];
				return {
					name: String(name),
					type: 'line',
					smooth: false,
					symbol: 'none',
					lineStyle: { width: 2 },
					itemStyle: { color: palette[i % palette.length] },
					data: values
				};
			});
			return baseOption(buckets.map((b) => formatInstant(b, range.grain)), seriesData, fmt, chrome, names.length > 1);
		}

		const current = series.filter((r) => r._window === 'current').sort((a, b) => a.bucket - b.bucket);
		const previous = series.filter((r) => r._window === 'comparison').sort((a, b) => a.bucket - b.bucket);
		const categories = current.map((r) => formatInstant(r.bucket, range.grain));

		const built = [
			{
				name: measure.label,
				type: 'line',
				smooth: false,
				symbol: 'none',
				lineStyle: { width: 2.5 },
				areaStyle: { opacity: mode === 'dark' ? 0.14 : 0.09 },
				itemStyle: { color: palette[0] },
				data: current.map((r) => r[measure.name] ?? null)
			}
		];

		if (comparing && previous.length) {
			// Right-aligned: the last bucket of the prior window sits under the last
			// bucket of this one, which is what makes "same point in the period"
			// mean anything when the two windows have different lengths.
			const offset = Math.max(0, current.length - previous.length);
			const aligned = new Array(current.length).fill(null);
			previous.slice(-current.length).forEach((row, i) => {
				aligned[offset + i] = row[measure.name] ?? null;
			});
			built.push({
				name: 'Previous period',
				type: 'line',
				smooth: false,
				symbol: 'none',
				lineStyle: { width: 1.5, type: 'dashed', color: chrome.muted },
				itemStyle: { color: chrome.muted },
				data: aligned
			});
		}

		return baseOption(categories, built, fmt, chrome, built.length > 1);
	};

	const baseOption = (categories, seriesData, fmt, chrome, legend) => ({
		animation: false,
		grid: { left: 8, right: 12, top: legend ? 34 : 12, bottom: 4, containLabel: true },
		legend: legend
			? { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: chrome.muted, fontSize: 11 } }
			: { show: false },
		tooltip: {
			trigger: 'axis',
			backgroundColor: chrome.tooltipBg,
			borderColor: chrome.tooltipBorder,
			textStyle: { color: chrome.text, fontSize: 12 },
			valueFormatter: fmt
		},
		xAxis: {
			type: 'category',
			data: categories,
			axisLine: { lineStyle: { color: chrome.axis } },
			axisTick: { show: false },
			axisLabel: { color: chrome.muted, fontSize: 11, hideOverlap: true }
		},
		yAxis: {
			type: 'value',
			splitLine: { lineStyle: { color: chrome.grid } },
			axisLabel: { color: chrome.muted, fontSize: 11, formatter: fmt }
		},
		series: seriesData
	});

	const draw = () => {
		if (!browser || !echarts || !chartEl || !range) return;
		chart ??= echarts.init(chartEl, null, { renderer: 'canvas' });
		chart.setOption(chartOption(), true);
		chart.resize();
	};

	$: if (browser && chartEl && echarts && (series || detail || mode || expanded || activeMeasure)) draw();

	let resizeObserver;
	onMount(() => {
		if (!browser) return;
		resizeObserver = new ResizeObserver(() => chart?.resize());
		if (chartEl) resizeObserver.observe(chartEl);
	});
	onDestroy(() => {
		resizeObserver?.disconnect();
		chart?.dispose();
	});

	/* ------------------------------------------------------------------ derived -- */

	/**
	 * Everything a measure card needs, in one place so the markup stays flat.
	 *
	 * `rows` and `withComparison` are parameters rather than closed-over state on
	 * purpose. Svelte derives a template expression's dependencies from what the
	 * expression mentions, so `card(name)` would be recomputed only when `name`
	 * changed — and the cards would show the first window's numbers for the rest
	 * of the session. Passing the state in is what makes the dependency visible.
	 */
	const card = (name, rows, withComparison) => {
		const at = (which) => rows?.find((r) => r._window === which)?.[name] ?? null;
		const measure = measureBy[name];
		const current = at('current');
		const previous = withComparison ? at('comparison') : null;
		const change = delta(current, previous);
		return { measure, current, change, favourable: isFavourable(change.direction, measure) };
	};

	const boardTotal = (rows) => rows.reduce((sum, r) => sum + (Number(r.current) || 0), 0);
	const boardMax = (rows) => Math.max(1, ...rows.map((r) => Math.abs(Number(r.current) || 0)));

	const toggleSql = (key) => {
		sqlShown = { ...sqlShown, [key]: !sqlShown[key] };
	};

	/** The catalog a Noodle worksheet would need — surfaced so the page can say so. */
	$: noodleFieldCount = view ? catalogFromMetricsView(view, RILL.models).fields.length : 0;
</script>

{#if !config || !view}
	<div class="rill missing">
		No explore named <code>{explore}</code> in <code>rill/explores/</code>.
		Available: {Object.keys(RILL.explores).join(', ') || 'none'}.
	</div>
{:else}
	<section class="rill" class:dark={mode === 'dark'}>
		<!-- ------------------------------------------------------------- header -- -->
		<header>
			<div class="who">
				<h3>{config.label}</h3>
				{#if config.description}<p class="sub">{config.description}</p>{/if}
			</div>

			<div class="controls">
				<!-- See Canvas.svelte: without this Chrome restores the previous range on reload. -->
				<select bind:value={rangeToken} autocomplete="off" aria-label="Time range">
					{#each config.timeRanges as token}
						<option value={token}>{rangeLabel(token)}</option>
					{/each}
				</select>

				<label class="toggle" class:off={!range?.comparison}>
					<input type="checkbox" bind:checked={comparisonOn} disabled={!range?.comparison} />
					<span>Compare to previous</span>
				</label>
			</div>
		</header>

		{#if range && bounds}
			<p class="window">
				<strong>{formatUtcDate(range.start)} → {formatUtcDate(new Date(range.end.getTime() - 1))}</strong>
				· anchored to the newest row in the data ({formatUtcDate(bounds.max)}), not to today
				{#if range.coverage < 0.999}
					· only {Math.round(range.coverage * 100)}% of this window has data
				{/if}
			</p>
			{#if range.comparisonNote}
				<p class="note">{range.comparisonNote}</p>
			{/if}
		{/if}

		<!-- ------------------------------------------------------------ filters -- -->
		{#if filterCount}
			<div class="pills">
				{#each Object.entries(filters) as [dimension, filter]}
					{#each filter.values as value}
						<button
							class="pill"
							class:exclude={filter.mode === 'exclude'}
							on:click={() => toggleFilter(dimension, value, filter.mode)}
							title="Remove this filter"
						>
							<span class="dim">{dimensionBy[dimension]?.label ?? dimension}</span>
							<span class="op">{filter.mode === 'exclude' ? 'is not' : 'is'}</span>
							<span class="val">{value}</span>
							<span class="x">×</span>
						</button>
					{/each}
				{/each}
				<button class="clear" on:click={clearFilters}>Clear all</button>
			</div>
		{/if}

		{#if error}
			<p class="error">{error}</p>
		{/if}

		<!-- -------------------------------------------------------------- cards -- -->
		<div class="cards">
			{#each shownMeasures as name}
				{@const c = card(name, totals, comparing)}
				<button
					class="card"
					class:active={activeMeasure === name}
					on:click={() => (activeMeasure = name)}
					title={c.measure?.description ?? `Chart ${c.measure?.label}`}
				>
					<span class="label">{c.measure?.label}</span>
					<span class="value">{formatMeasure(c.current, c.measure, { compact: true })}</span>
					{#if comparing}
						<span
							class="change"
							class:good={c.favourable === true}
							class:bad={c.favourable === false}
						>
							{formatDelta(c.change.absolute, c.measure, { compact: true })}
							{#if c.change.relative !== null}
								<em>{formatPercent(c.change.relative)}</em>
							{:else}
								<em title="The previous window was zero, so a percentage would invent a denominator">n/a</em>
							{/if}
						</span>
					{:else}
						<span class="change muted">no comparison</span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- -------------------------------------------------------------- chart -- -->
		<div class="panel">
			<div class="panel-head">
				<h4>
					{activeMeasureDef?.label}
					{#if expanded}<span class="split">split by {dimensionBy[expanded]?.label}</span>{/if}
					<span class="grain">by {range?.grain ?? 'day'}</span>
				</h4>
				<div class="panel-actions">
					{#if expanded}
						<button class="ghost" on:click={() => (expanded = null)}>Collapse</button>
					{/if}
					<button class="ghost" on:click={() => toggleSql('chart')}>
						{sqlShown.chart ? 'Hide SQL' : 'SQL'}
					</button>
				</div>
			</div>
			<div class="chart" bind:this={chartEl} class:busy={loading}></div>
			{#if sqlShown.chart}
				<pre class="sql">{(expanded ? queries.detail : queries.series) ?? ''}</pre>
			{/if}
		</div>

		<!-- ------------------------------------------------------- leaderboards -- -->
		<div class="boards">
			{#each shownDimensions as name}
				{@const board = boards[name] ?? { rows: [] }}
				{@const total = boardTotal(board.rows)}
				{@const max = boardMax(board.rows)}
				<div class="board">
					<div class="panel-head">
						<h4>{dimensionBy[name]?.label ?? name}</h4>
						<div class="panel-actions">
							<button
								class="ghost"
								class:on={expanded === name}
								on:click={() => (expanded = expanded === name ? null : name)}
								title="Split the chart above by this dimension"
							>
								{expanded === name ? 'Collapse' : 'Expand'}
							</button>
							<button class="ghost" on:click={() => toggleSql(name)}>{sqlShown[name] ? 'Hide' : 'SQL'}</button>
						</div>
					</div>

					<ul style={`--rows:${leaderboardRows}`}>
						{#each board.rows as row}
							{@const change = delta(row.current, comparing ? row.comparison : null)}
							{@const share = percentOfTotal(row.current, total, activeMeasureDef)}
							<li class:selected={isFiltered(filters, name, row.value)}>
								<button class="value" on:click={() => toggleFilter(name, row.value)} title="Filter to this value">
									<span
										class="bar"
										style={`width:${Math.max(1, (Math.abs(Number(row.current) || 0) / max) * 100)}%`}
									></span>
									<span class="name">{row.value ?? '—'}</span>
									<span class="num">{formatMeasure(row.current, activeMeasureDef, { compact: true })}</span>
									{#if share !== null}
										<span class="share">{Math.round(share * 100)}%</span>
									{/if}
									{#if comparing && change.relative !== null}
										<span class="trend" class:good={change.direction === 'up'} class:bad={change.direction === 'down'}>
											{formatPercent(change.relative)}
										</span>
									{/if}
								</button>
								<button
									class="minus"
									on:click={() => toggleFilter(name, row.value, 'exclude')}
									title="Exclude this value"
								>−</button>
							</li>
						{/each}
						{#if !board.rows.length && !loading}
							<li class="empty">No values in this window.</li>
						{/if}
					</ul>

					{#if !activeMeasureDef?.percentOfTotal}
						<p class="foot" title="valid_percent_of_total is not set on this measure in rill/metrics/">
							{activeMeasureDef?.label} does not add up across slices, so no share is shown.
						</p>
					{/if}
					{#if sqlShown[name]}
						<pre class="sql">{board.sql ?? ''}</pre>
					{/if}
				</div>
			{/each}
		</div>

		<!-- ------------------------------------------------------ escape hatch -- -->
		{#if escapeHatch}
			<div class="hatch">
				<h4>Take it further</h4>
				<p>
					Every panel above shows its SQL and none of them let you change it — a governed measure
					that a reader can redefine in place is no longer governed. Below is the same window as a
					query that <em>is</em> yours to edit; it starts from the headline figures and answers to
					nobody. The metrics view is unaffected either way, and
					<a href="/noodle">a Noodle worksheet</a> on the same
					{noodleFieldCount} fields will build anything this layout does not.
				</p>
				{#if queries.totals}
					<LiveQuery sql={queries.totals} title="{config.label} — this window" rowsShown={8} />
				{/if}
			</div>
		{/if}

		<footer class="provenance">
			Defined in <code>{view.file}</code> and <code>{config.file}</code>, compiled by
			<code>npm run rill:model</code>. <code>rill start rill/</code> renders the same dashboard from
			the same files.
			{#if bounds}<span>{bounds.rows.toLocaleString()} rows in <code>{viewName(view)}</code>.</span>{/if}
		</footer>
	</section>
{/if}

<style>
	.rill {
		--bg: #ffffff;
		--panel: #fafafa;
		--line: #e4e4e7;
		--text: #18181b;
		--muted: #71717a;
		--accent: #2a78d6;
		--good: #0ca30c;
		--bad: #d03b3b;
		font-size: 0.875rem;
		color: var(--text);
		margin: 1.5rem 0;
	}
	.rill.dark {
		--bg: #09090b;
		--panel: #18181b;
		--line: #27272a;
		--text: #fafafa;
		--muted: #a1a1aa;
		--accent: #3987e5;
	}

	.missing {
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 1rem;
		color: var(--muted);
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		flex-wrap: wrap;
	}
	h3 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.sub {
		margin: 0.15rem 0 0;
		color: var(--muted);
		font-size: 0.8rem;
		max-width: 62ch;
	}
	.controls {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	select {
		font: inherit;
		font-size: 0.8rem;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: 5px;
		background: var(--bg);
		color: var(--text);
	}
	.toggle {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
		font-size: 0.8rem;
		color: var(--muted);
		cursor: pointer;
	}
	.toggle.off {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.window {
		margin: 0.5rem 0 0;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.note {
		margin: 0.3rem 0 0;
		font-size: 0.78rem;
		color: var(--text);
		background: color-mix(in srgb, #fab219 18%, transparent);
		border-left: 2px solid #fab219;
		padding: 0.35rem 0.6rem;
		border-radius: 0 4px 4px 0;
	}
	.error {
		margin: 0.5rem 0;
		color: var(--bad);
		font-family: ui-monospace, monospace;
		font-size: 0.78rem;
	}

	.pills {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
	}
	.pill,
	.clear {
		font: inherit;
		font-size: 0.75rem;
		border: 1px solid var(--line);
		background: var(--panel);
		color: var(--text);
		border-radius: 999px;
		padding: 0.2rem 0.6rem;
		cursor: pointer;
		display: inline-flex;
		gap: 0.3rem;
		align-items: center;
	}
	.pill.exclude {
		border-style: dashed;
	}
	.pill .dim {
		color: var(--muted);
	}
	.pill .op {
		color: var(--muted);
		font-style: italic;
	}
	.pill .x {
		color: var(--muted);
		font-weight: 600;
	}
	.clear {
		border-color: transparent;
		color: var(--muted);
		text-decoration: underline;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.6rem;
		margin-top: 0.9rem;
	}
	.card {
		font: inherit;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--bg);
		color: var(--text);
		padding: 0.6rem 0.7rem;
		cursor: pointer;
	}
	.card.active {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.card .label {
		font-size: 0.72rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.card .value {
		font-size: 1.35rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}
	.card .change {
		font-size: 0.74rem;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}
	.card .change em {
		font-style: normal;
		margin-left: 0.3rem;
		opacity: 0.85;
	}
	.change.good {
		color: var(--good);
	}
	.change.bad {
		color: var(--bad);
	}

	.panel,
	.board,
	.hatch {
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--bg);
		margin-top: 0.8rem;
	}
	.panel-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0.7rem;
		border-bottom: 1px solid var(--line);
	}
	.panel-head h4 {
		margin: 0;
		font-size: 0.82rem;
		font-weight: 600;
		display: flex;
		gap: 0.45rem;
		align-items: baseline;
	}
	.split,
	.grain {
		font-weight: 400;
		font-size: 0.74rem;
		color: var(--muted);
	}
	.panel-actions {
		display: flex;
		gap: 0.3rem;
	}
	.ghost {
		font: inherit;
		font-size: 0.72rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted);
		border-radius: 4px;
		padding: 0.15rem 0.45rem;
		cursor: pointer;
	}
	.ghost:hover,
	.ghost.on {
		border-color: var(--line);
		color: var(--text);
	}

	.chart {
		height: 280px;
		width: 100%;
	}
	.chart.busy {
		opacity: 0.55;
		transition: opacity 0.15s;
	}

	.sql {
		margin: 0;
		border-top: 1px solid var(--line);
		padding: 0.6rem 0.7rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		line-height: 1.45;
		color: var(--muted);
		overflow-x: auto;
		white-space: pre;
		background: var(--panel);
		border-radius: 0 0 6px 6px;
	}

	.boards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 0.8rem;
	}
	.board ul {
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		max-height: calc(var(--rows) * 1.85rem + 0.5rem);
		overflow-y: auto;
	}
	.board li {
		display: flex;
		align-items: stretch;
		gap: 0.15rem;
	}
	.board li.empty {
		padding: 0.5rem;
		color: var(--muted);
		font-size: 0.78rem;
	}
	.board .value {
		position: relative;
		flex: 1;
		font: inherit;
		font-size: 0.78rem;
		text-align: left;
		border: none;
		background: transparent;
		color: var(--text);
		padding: 0.28rem 0.4rem;
		border-radius: 4px;
		cursor: pointer;
		display: grid;
		grid-template-columns: 1fr auto auto auto;
		gap: 0.5rem;
		align-items: center;
		overflow: hidden;
	}
	.board .bar {
		position: absolute;
		inset: 2px auto 2px 0;
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		border-radius: 3px;
		z-index: 0;
	}
	.board .name,
	.board .num,
	.board .share,
	.board .trend {
		position: relative;
		z-index: 1;
	}
	.board .name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.board .num {
		font-variant-numeric: tabular-nums;
	}
	.board .share,
	.board .trend {
		font-size: 0.7rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		min-width: 2.8rem;
		text-align: right;
	}
	.trend.good {
		color: var(--good);
	}
	.trend.bad {
		color: var(--bad);
	}
	.board li.selected .value {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.minus {
		font: inherit;
		border: none;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		padding: 0 0.4rem;
		border-radius: 4px;
		opacity: 0;
	}
	.board li:hover .minus,
	.minus:focus {
		opacity: 1;
	}
	.foot {
		margin: 0;
		padding: 0.3rem 0.7rem 0.55rem;
		font-size: 0.7rem;
		color: var(--muted);
		border-top: 1px dotted var(--line);
	}

	.hatch {
		padding: 0.7rem 0.8rem 0.9rem;
	}
	.hatch h4 {
		margin: 0 0 0.3rem;
		font-size: 0.82rem;
	}
	.hatch p {
		margin: 0 0 0.6rem;
		font-size: 0.8rem;
		color: var(--muted);
		max-width: 78ch;
	}

	.provenance {
		margin-top: 0.7rem;
		font-size: 0.72rem;
		color: var(--muted);
	}
	.provenance code {
		font-size: 0.95em;
	}

	@media print {
		.controls,
		.panel-actions,
		.minus,
		.hatch,
		.clear {
			display: none;
		}
	}
</style>
