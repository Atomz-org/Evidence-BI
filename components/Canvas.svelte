<!--
  Canvas — one board, five tools.

  Everything this project can do, over one governed metrics view, sharing one
  time window and one set of filters. The layout is a file (`canvas/*.yaml`);
  nothing below is arranged in code.

    dbt          the marts, and the rule that a measure has one definition
    Rill         the grammar, the window and the window before it, the KPI row,
                 leaderboards, cross-filtering
    flint-chart  every chart — described by what the columns *mean*, not by
                 chart configuration
    Cube         the pivot, with totals computed rather than added up
    notebooks    one cell whose SQL the reader can actually run

  The point of putting them together is not that five things fit on a page. It
  is that they stop being five things: click a region on the leaderboard and the
  KPI row, both charts, the pivot and the notebook cell all narrow, because they
  are all reading the same scan of the same view. A dashboard assembled from
  five tools that each own their own filter state is five dashboards on one
  page, and the reader is the one who has to notice they disagree.

  What is governed and what is not is visible rather than assumed. Every
  compiled tile shows its SQL and refuses to let you edit it; the notebook cell
  says plainly that it is yours.
-->
<script>
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';

	import FlintChart from './FlintChart.svelte';
	import LiveQuery from './LiveQuery.svelte';
	import { RILL } from './rill/model.generated.js';
	import {
		boundsSql,
		createViewSql,
		gridSql,
		leaderboardSql,
		scanSubquery,
		totalsSql,
		viewName
	} from './rill/engine/metrics.js';
	import { isTotalKey, keyLabel, pivotSql, shapePivot } from './canvas/pivot.js';
	import { formatUtcDate, rangeLabel, resolveRange } from './rill/engine/timerange.js';
	import {
		delta,
		formatDelta,
		formatMeasure,
		formatPercent,
		isFavourable,
		percentOfTotal
	} from './rill/engine/format.js';
	import { detectMode } from './noodle/engine/theme.js';
	import { createSequencer } from './noodle/engine/runner.js';

	/** Which board in canvas/ to render. */
	export let canvas = Object.keys(RILL.canvases ?? {})[0];

	const board = RILL.canvases?.[canvas];
	const view = board ? RILL.metricsViews[board.metricsView] : null;

	const measureBy = Object.fromEntries((view?.measures ?? []).map((m) => [m.name, m]));
	const dimensionBy = Object.fromEntries((view?.dimensions ?? []).map((d) => [d.name, d]));

	/** Every tile, flattened with a stable id so results can be keyed by it. */
	const tiles = (board?.rows ?? []).flatMap((row, r) =>
		row.items.map((item, i) => ({ ...item, id: `t${r}_${i}`, row: r }))
	);

	/* ------------------------------------------------------------------ state -- */

	let rangeToken = board?.defaults.timeRange ?? 'inf';
	let comparisonOn = board?.defaults.comparisonMode === 'time';
	/** @type {Record<string, {mode:'include'|'exclude', values:string[]}>} */
	let filters = { ...(board?.defaults.filters ?? {}) };

	/** Per-tile overrides the reader can change without touching the file. */
	let pivotState = Object.fromEntries(
		tiles
			.filter((t) => t.component === 'x_pivot')
			.map((t) => [
				t.id,
				{
					rows: [...(t.config.rows ?? [])],
					columns: [...(t.config.columns ?? [])],
					measures: [...(t.config.measures ?? [])]
				}
			])
	);

	let bounds = null;
	let results = {};
	let queries = {};
	let sqlShown = {};
	let error = null;
	let loading = true;
	let mode = 'light';
	let duck = null;
	const sequencer = createSequencer();

	$: range = bounds ? resolveRange(rangeToken, bounds, view?.smallestTimeGrain) : null;
	$: comparing = comparisonOn && !!range?.comparison;
	$: filterCount = Object.values(filters).reduce((n, f) => n + (f?.values?.length ?? 0), 0);
	$: scanForNotebook = range && view ? scanSubquery(view, { range, filters }) : null;

	/* ------------------------------------------------------------------- data -- */

	const plain = (rows) => JSON.parse(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));

	/**
	 * The query for one tile.
	 *
	 * Every tile funnels through the same two builders — `gridSql` for anything
	 * shaped like "dimensions × measures", `pivotSql` for the grid. A bespoke
	 * query per component is how two tiles on one board come to disagree about
	 * what a filter means.
	 */
	const tileQuery = (tile) => {
		const scope = { range: comparing ? range : { ...range, comparison: null }, filters };
		const { config } = tile;

		switch (tile.component) {
			case 'kpi_grid':
				return totalsSql(view, { ...scope, measures: config.measures });

			case 'line_chart':
			case 'area_chart':
			case 'stacked_bar':
				return gridSql(view, {
					...scope,
					grain: config.grain ?? range.grain,
					dimensions: config.series ? [config.series] : [],
					measures: [config.measure]
				});

			case 'bar_chart':
				return gridSql(view, {
					...scope,
					dimensions: [config.dimension, config.series].filter(Boolean),
					measures: [config.measure]
				});

			case 'donut_chart':
				return gridSql(view, { ...scope, dimensions: [config.dimension], measures: [config.measure] });

			case 'heatmap':
				return gridSql(view, {
					...scope,
					// A heatmap's two axes are both categorical unless the layout asks
					// for time on one of them; `y` and `grain` are the two ways to say
					// which, and the generator refuses a heatmap with neither.
					grain: config.y ? null : (config.grain ?? range.grain),
					dimensions: [config.dimension, config.y].filter(Boolean),
					measures: [config.measure]
				});

			case 'table':
				return gridSql(view, {
					...scope,
					dimensions: config.dimensions ?? [config.dimension].filter(Boolean),
					measures: config.measures ?? [config.measure].filter(Boolean),
					limit: config.limit ?? 200
				});

			case 'x_leaderboard':
				return leaderboardSql(view, {
					dimension: config.dimension,
					measure: config.measure,
					...scope,
					limit: 60
				});

			case 'x_pivot':
				return pivotSql(view, { ...pivotState[tile.id], ...scope, totals: config.totals !== false });

			default:
				return null; // markdown and the notebook cell ask nothing
		}
	};

	const refresh = async () => {
		if (!duck || !view || !range) return;
		loading = true;
		error = null;

		const outcome = await sequencer.run(async () => {
			const next = {};
			const asked = {};
			await Promise.all(
				tiles.map(async (tile) => {
					const sql = tileQuery(tile);
					asked[tile.id] = sql;
					next[tile.id] = sql ? plain(await duck.query(sql)) : null;
				})
			);
			return { next, asked };
		});

		if (!outcome) return; // superseded
		results = outcome.next;
		queries = outcome.asked;
		loading = false;
	};

	onMount(async () => {
		if (!browser || !view) return;
		mode = detectMode();
		try {
			duck = await import('@evidence-dev/universal-sql/client-duckdb');
			await duck.query(createViewSql(view, RILL.models));
			const [b] = plain(await duck.query(boundsSql(view)));
			bounds = { min: new Date(b.lo), max: new Date(b.hi), rows: Number(b.rows) };
			await refresh();
		} catch (e) {
			error = String(e?.message ?? e);
			loading = false;
		}

		// Repaint when the theme switcher flips the surface underneath the board.
		themeObserver = new MutationObserver(() => {
			const next = detectMode();
			if (next !== mode) mode = next;
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
	});

	// Svelte ignores what an *async* onMount returns — it is a promise, not a
	// cleanup — so the observer is torn down here instead of from inside it.
	let themeObserver = null;
	onDestroy(() => themeObserver?.disconnect());

	// Collected into an array so the guard cannot be falsified by its last operand.
	$: inputs = [rangeToken, comparing, filters, pivotState];
	$: if (duck && bounds && inputs) refresh();

	/* ---------------------------------------------------------------- actions -- */

	const toggleFilter = (dimension, value, mode_ = 'include') => {
		const existing = filters[dimension];
		const values = new Set(existing?.mode === mode_ ? existing.values : []);
		if (values.has(value)) values.delete(value);
		else values.add(value);
		filters = values.size
			? { ...filters, [dimension]: { mode: mode_, values: [...values] } }
			: Object.fromEntries(Object.entries(filters).filter(([k]) => k !== dimension));
	};

	const clearFilters = () => (filters = {});
	const toggleSql = (id) => (sqlShown = { ...sqlShown, [id]: !sqlShown[id] });

	/** Move a dimension between the pivot's axes, or off it. */
	const placeDimension = (id, dimension, axis) => {
		const state = pivotState[id];
		const next = {
			rows: state.rows.filter((d) => d !== dimension),
			columns: state.columns.filter((d) => d !== dimension),
			measures: state.measures
		};
		if (axis === 'rows') next.rows = [...next.rows, dimension];
		if (axis === 'columns') next.columns = [...next.columns, dimension];
		pivotState = { ...pivotState, [id]: next };
	};

	const togglePivotMeasure = (id, measure) => {
		const state = pivotState[id];
		const measures = state.measures.includes(measure)
			? state.measures.filter((m) => m !== measure)
			: [...state.measures, measure];
		// A pivot with no measure is an empty grid with headers; keep the last one.
		if (!measures.length) return;
		pivotState = { ...pivotState, [id]: { ...state, measures } };
	};

	/**
	 * Which axis a dimension sits on.
	 *
	 * `state` is a parameter, not read from the closure, for the same reason
	 * `card` takes its rows: Svelte derives a template expression's dependencies
	 * from the identifiers the expression mentions. `pivotAxisOf(id, name)`
	 * mentions neither `pivotState` nor `results`, so it would be evaluated once
	 * and the chips would never move again.
	 */
	const pivotAxisOf = (state, dimension) =>
		state.rows.includes(dimension) ? 'rows' : state.columns.includes(dimension) ? 'columns' : 'off';

	/* ---------------------------------------------------------------- shaping -- */

	/** Card data. Rows and `withComparison` are arguments so Svelte tracks them. */
	const card = (name, rows, withComparison) => {
		const measure = measureBy[name];
		const at = (which) => rows?.find((r) => r._window === which)?.[name] ?? null;
		const current = at('current');
		const change = delta(current, withComparison ? at('comparison') : null);
		return { measure, current, change, favourable: isFavourable(change.direction, measure) };
	};

	/**
	 * Rows for a Flint chart.
	 *
	 * Flint is handed the *meaning* of each column, not a chart configuration —
	 * the semantic types come from the metrics view via the generator, so a
	 * currency measure gets a zero baseline on every chart of it without any
	 * tile saying so. Bucket timestamps are turned into Dates here because Flint
	 * reads a temporal type off the value, and duckdb-wasm hands back epoch
	 * milliseconds.
	 */
	const chartRows = (rows) =>
		(rows ?? [])
			.filter((r) => !r._window || r._window === 'current')
			.map((r) => {
				const out = { ...r };
				delete out._window;
				if (out.bucket !== undefined) out.bucket = new Date(out.bucket);
				return out;
			});

	/**
	 * Which column goes on which Flint channel.
	 *
	 * One function rather than ternaries in the markup, because the channels are
	 * not interchangeable and getting them wrong fails quietly: a Heatmap given a
	 * measure on `y` draws a line, a Pie given `x`/`y` draws nothing. The catalog
	 * in .claude/skills/flint-chart/references/chart-catalog.md is the authority
	 * for which template accepts what.
	 */
	const chartChannels = (tile) => {
		const { config, component } = tile;
		switch (component) {
			case 'donut_chart':
				// Pie reads `size` and `color`; it has no positional channels.
				return { encodings: { size: config.measure, color: config.dimension }, measureChannel: 'size' };
			case 'heatmap':
				// Two categorical axes, the measure on colour.
				return {
					x: config.y ? config.dimension : 'bucket',
					y: config.y ?? config.dimension,
					encodings: { color: config.measure },
					measureChannel: 'color'
				};
			case 'bar_chart':
				// Horizontal when the layout asks. In a four-column tile six status
				// labels on a vertical axis rotate to ninety degrees and stop being
				// readable; on the left of a horizontal bar they are just words.
				return config.orientation === 'horizontal'
					? { x: config.measure, y: config.dimension, series: config.series, encodings: {}, measureChannel: 'x' }
					: { x: config.dimension, y: config.measure, series: config.series, encodings: {}, measureChannel: 'y' };
			default:
				// Time on x for the temporal templates.
				return { x: 'bucket', y: config.measure, series: config.series, encodings: {}, measureChannel: 'y' };
		}
	};

	const chartTypes = (tile) => {
		const wanted = {};
		const { config } = tile;
		const keys = new Set(['bucket', config.measure, config.series, config.dimension, config.y].filter(Boolean));
		for (const key of keys) if (tile.types[key]) wanted[key] = tile.types[key];
		return wanted;
	};

	const chartLabels = (tile) => {
		const out = { bucket: 'Date' };
		for (const [name, m] of Object.entries(measureBy)) out[name] = m.label;
		for (const [name, d] of Object.entries(dimensionBy)) out[name] = d.label;
		return out;
	};

	/** Evidence fmt code for a measure, so Flint's axis and tooltip agree with the cards. */
	const fmtFor = (name) => {
		const preset = measureBy[name]?.formatPreset;
		return preset === 'currency_usd' ? 'usd0k' : preset === 'percentage' ? 'pct1' : 'num0';
	};

	/**
	 * The format, on the channel the measure actually occupies.
	 *
	 * `fmt` alone only reaches `y` and `value`, which is right until the measure
	 * moves — a horizontal bar puts it on `x` and a heatmap on `color`, and both
	 * then print raw floats on an axis this project never ships raw floats on.
	 * theme-bridge's own audit flags it, but only in the console.
	 */
	const formatsFor = (tile, channels) => {
		const code = fmtFor(tile.config.measure);
		return { [channels.measureChannel ?? 'y']: code, value: code };
	};

	/** See `pivotAxisOf` for why `rows` and `state` are parameters. */
	const grid = (rows, state, tile) => shapePivot(rows, { ...state, totals: tile.config.totals !== false });
</script>

{#if !board || !view}
	<div class="canvas missing">
		No canvas named <code>{canvas}</code> in <code>canvas/</code>.
		Available: {Object.keys(RILL.canvases ?? {}).join(', ') || 'none'}.
	</div>
{:else}
	<section class="canvas" class:dark={mode === 'dark'} style="--gap-x:{board.gapX}px; --gap-y:{board.gapY}px">
		<!-- ------------------------------------------------------------ header -- -->
		<header>
			<div class="who">
				<h3>{board.label}</h3>
				{#if board.description}<p class="sub">{board.description}</p>{/if}
			</div>
			<div class="controls">
				<!--
					`autocomplete="off"` is load-bearing. Chrome restores a select's
					previous value on reload, which silently overrides the range the
					layout file declares — a board whose entire premise is that the file
					decides the initial state would open on whatever the last visitor
					happened to pick.
				-->
				<select bind:value={rangeToken} autocomplete="off" aria-label="Time range">
					{#each board.timeRanges as token}
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
				· anchored to the newest row ({formatUtcDate(bounds.max)}), not to today
				· {bounds.rows.toLocaleString()} rows in <code>{viewName(view)}</code>
			</p>
			{#if range.comparisonNote}<p class="note">{range.comparisonNote}</p>{/if}
		{/if}

		{#if filterCount}
			<div class="pills">
				{#each Object.entries(filters) as [dimension, filter]}
					{#each filter.values as value}
						<button class="pill" class:exclude={filter.mode === 'exclude'} on:click={() => toggleFilter(dimension, value, filter.mode)}>
							<span class="dim">{dimensionBy[dimension]?.label ?? dimension}</span>
							<span class="op">{filter.mode === 'exclude' ? 'is not' : 'is'}</span>
							<span class="val">{value}</span>
							<span class="x">×</span>
						</button>
					{/each}
				{/each}
				<button class="clear" on:click={clearFilters}>Clear all</button>
				<span class="reach">filters every tile below</span>
			</div>
		{/if}

		{#if error}<p class="error">{error}</p>{/if}

		<!-- -------------------------------------------------------------- rows -- -->
		{#each board.rows as row, r}
			<div class="row" style={row.height ? `--row-height:${row.height}px` : ''}>
				{#each row.items as item, i}
					{@const tile = tiles.find((t) => t.id === `t${r}_${i}`)}
					{@const data = results[tile.id]}
					<div class="cell" style="--span:{item.width}">
						<!-- --------------------------------------------------- kpi_grid -- -->
						{#if item.component === 'kpi_grid'}
							<div class="kpis">
								{#each item.config.measures as name}
									{@const c = card(name, data, comparing && item.config.comparison !== false)}
									<div class="kpi">
										<span class="label">{c.measure?.label}</span>
										<span class="value">{formatMeasure(c.current, c.measure, { compact: true })}</span>
										<span class="change" class:good={c.favourable === true} class:bad={c.favourable === false}>
											{#if c.change.absolute !== null}
												{formatDelta(c.change.absolute, c.measure, { compact: true })}
												{#if c.change.relative !== null}<em>{formatPercent(c.change.relative)}</em>{/if}
											{:else}
												<span class="muted">no comparison</span>
											{/if}
										</span>
									</div>
								{/each}
							</div>

						<!-- -------------------------------------------------- markdown -- -->
						{:else if item.component === 'markdown'}
							<div class="prose">{item.config.content ?? ''}</div>

						<!-- --------------------------------------------- flint charts -- -->
						{:else if item.flintTemplate}
							<div class="panel">
								<div class="panel-head thin">
									<span class="by">via flint-chart · {item.flintTemplate}</span>
									<button class="ghost" on:click={() => toggleSql(tile.id)}>{sqlShown[tile.id] ? 'Hide SQL' : 'SQL'}</button>
								</div>
								<div class="body">
									{#if data?.length}
										{@const ch = chartChannels(tile)}
										<FlintChart
											data={chartRows(data)}
											chartType={item.flintTemplate}
											x={ch.x}
											y={ch.y}
											series={ch.series}
											encodings={ch.encodings}
											types={chartTypes(tile)}
											labels={chartLabels(tile)}
											fmt={fmtFor(item.config.measure)}
											formats={formatsFor(tile, ch)}
											title={item.config.title ?? measureBy[item.config.measure]?.label}
											grow={false}
											subtitle={item.config.subtitle}
											height={(row.height ?? 320) - 108}
											hasTable={true}
										/>
									{:else}
										<p class="empty">{loading ? 'Querying…' : 'Nothing in this window.'}</p>
									{/if}
								</div>
								{#if sqlShown[tile.id]}<pre class="sql">{queries[tile.id] ?? ''}</pre>{/if}
							</div>

						<!-- ----------------------------------------------- leaderboard -- -->
						{:else if item.component === 'x_leaderboard'}
							{@const total = (data ?? []).reduce((s, x) => s + (Number(x.current) || 0), 0)}
							{@const max = Math.max(1, ...(data ?? []).map((x) => Math.abs(Number(x.current) || 0)))}
							{@const measure = measureBy[item.config.measure]}
							<div class="panel">
								<div class="panel-head">
									<h4>
										{dimensionBy[item.config.dimension]?.label}
										<span class="by">Rill · click to filter the board</span>
									</h4>
									<button class="ghost" on:click={() => toggleSql(tile.id)}>{sqlShown[tile.id] ? 'Hide' : 'SQL'}</button>
								</div>
								<ul class="board">
									{#each data ?? [] as entry}
										{@const change = delta(entry.current, comparing ? entry.comparison : null)}
										{@const share = percentOfTotal(entry.current, total, measure)}
										<li class:selected={filters[item.config.dimension]?.values.includes(entry.value)}>
											<button class="value" on:click={() => toggleFilter(item.config.dimension, entry.value)}>
												<span class="bar" style={`width:${Math.max(1, (Math.abs(Number(entry.current) || 0) / max) * 100)}%`}></span>
												<span class="name">{entry.value ?? '—'}</span>
												<span class="num">{formatMeasure(entry.current, measure, { compact: true })}</span>
												{#if share !== null}<span class="share">{Math.round(share * 100)}%</span>{/if}
												{#if comparing && change.relative !== null}
													<span class="trend" class:good={change.direction === 'up'} class:bad={change.direction === 'down'}>
														{formatPercent(change.relative)}
													</span>
												{/if}
											</button>
											<button class="minus" title="Exclude" on:click={() => toggleFilter(item.config.dimension, entry.value, 'exclude')}>−</button>
										</li>
									{/each}
								</ul>
								{#if sqlShown[tile.id]}<pre class="sql">{queries[tile.id] ?? ''}</pre>{/if}
							</div>

						<!-- ----------------------------------------------------- pivot -- -->
						{:else if item.component === 'x_pivot'}
							{@const state = pivotState[tile.id]}
							{@const g = grid(data, state, tile)}
							<div class="panel">
								<div class="panel-head">
									<h4>
										{item.config.title ?? 'Pivot'}
										<span class="by">Cube-style · totals computed, never added</span>
									</h4>
									<button class="ghost" on:click={() => toggleSql(tile.id)}>{sqlShown[tile.id] ? 'Hide' : 'SQL'}</button>
								</div>

								<div class="shelves">
									{#each view.dimensions as dimension}
										{@const axis = pivotAxisOf(state, dimension.name)}
										<div class="chip" class:on={axis !== 'off'}>
											<span>{dimension.label}</span>
											<button class:active={axis === 'rows'} title="Down the side" on:click={() => placeDimension(tile.id, dimension.name, axis === 'rows' ? 'off' : 'rows')}>↓</button>
											<button class:active={axis === 'columns'} title="Across the top" on:click={() => placeDimension(tile.id, dimension.name, axis === 'columns' ? 'off' : 'columns')}>→</button>
										</div>
									{/each}
									<span class="divider"></span>
									{#each view.measures as measure}
										<button
											class="chip measure"
											class:on={state.measures.includes(measure.name)}
											on:click={() => togglePivotMeasure(tile.id, measure.name)}
										>{measure.label}</button>
									{/each}
								</div>

								<div class="grid-wrap">
									<table class="pivot">
										<thead>
											<tr>
												<th class="corner">{state.rows.map((d) => dimensionBy[d]?.label).join(' · ') || '—'}</th>
												{#each g.colKeys as ck}
													<th colspan={state.measures.length} class:total={isTotalKey(ck)}>{keyLabel(ck)}</th>
												{/each}
											</tr>
											{#if state.measures.length > 1}
												<tr class="measures">
													<th></th>
													{#each g.colKeys as ck}
														{#each state.measures as m}
															<th class:total={isTotalKey(ck)}>{measureBy[m]?.label}</th>
														{/each}
													{/each}
												</tr>
											{/if}
										</thead>
										<tbody>
											{#each g.rowKeys as rk}
												<tr class:total={isTotalKey(rk)}>
													<th>{keyLabel(rk)}</th>
													{#each g.colKeys as ck}
														{#each state.measures as m}
															<td class:total={isTotalKey(ck) || isTotalKey(rk)}>
																{formatMeasure(g.cell(rk, ck, m), measureBy[m], { compact: true })}
															</td>
														{/each}
													{/each}
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
								<p class="foot">
									A total here is the measure's own expression over the whole slice. Adding the cells
									would give {measureBy[state.measures[0]]?.label} a different number wherever it is a
									ratio or a distinct count.
								</p>
								{#if sqlShown[tile.id]}<pre class="sql">{queries[tile.id] ?? ''}</pre>{/if}
							</div>

						<!-- -------------------------------------------------- notebook -- -->
						{:else if item.component === 'x_notebook'}
							<div class="panel notebook">
								<div class="panel-head">
									<h4>
										{item.config.title ?? 'Ask something else'}
										<span class="by">not governed — this one is yours</span>
									</h4>
								</div>
								<div class="body">
									{#if item.config.markdown}<p class="prose">{item.config.markdown}</p>{/if}
									{#if scanForNotebook}
										<LiveQuery
											sql={item.config.sql.replaceAll('{{scan}}', scanForNotebook)}
											title="{board.label} — the current window"
											open={true}
											rowsShown={10}
										/>
									{/if}
								</div>
							</div>

						<!-- ----------------------------------------------------- table -- -->
						{:else if item.component === 'table'}
							<div class="panel">
								<div class="panel-head">
									<h4>{item.config.title ?? 'Detail'}</h4>
									<button class="ghost" on:click={() => toggleSql(tile.id)}>{sqlShown[tile.id] ? 'Hide' : 'SQL'}</button>
								</div>
								<div class="grid-wrap">
									<table class="plain">
										<thead>
											<tr>
												{#each Object.keys(data?.[0] ?? {}) as key}
													<th>{measureBy[key]?.label ?? dimensionBy[key]?.label ?? key}</th>
												{/each}
											</tr>
										</thead>
										<tbody>
											{#each (data ?? []).slice(0, item.config.limit ?? 20) as entry}
												<tr>
													{#each Object.entries(entry) as [key, value]}
														<td>{measureBy[key] ? formatMeasure(value, measureBy[key]) : String(value ?? '—')}</td>
													{/each}
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
								{#if sqlShown[tile.id]}<pre class="sql">{queries[tile.id] ?? ''}</pre>{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/each}

		<footer class="provenance">
			Laid out by <code>{board.file}</code>, measured by <code>{view.file}</code>.
			Charts by flint-chart from semantic types the metrics view supplies; the pivot's totals by
			<code>GROUPING SETS</code>. Tiles marked <code>x_</code> in the layout file are this project's,
			not Rill's.
		</footer>
	</section>
{/if}

<style>
	.canvas {
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
	.canvas.dark {
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
		max-width: 66ch;
	}
	.controls {
		display: flex;
		gap: 0.6rem;
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
		background: color-mix(in srgb, #fab219 18%, transparent);
		border-left: 2px solid #fab219;
		padding: 0.35rem 0.6rem;
		border-radius: 0 4px 4px 0;
	}
	.error {
		color: var(--bad);
		font-family: ui-monospace, monospace;
		font-size: 0.78rem;
	}

	.pills {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
		align-items: center;
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
	.pill .dim,
	.pill .op,
	.pill .x {
		color: var(--muted);
	}
	.pill .op {
		font-style: italic;
	}
	.clear {
		border-color: transparent;
		color: var(--muted);
		text-decoration: underline;
	}
	.reach {
		font-size: 0.72rem;
		color: var(--muted);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		gap: var(--gap-y) var(--gap-x);
		margin-top: var(--gap-y);
	}
	.cell {
		grid-column: span var(--span);
		min-width: 0;
		/*
		 * A fixed height, not a content-driven one. A chart that can grow its own
		 * container is a feedback loop: flint sizes the canvas, the row gets
		 * taller, the ResizeObserver fires, flint sizes it again. The page never
		 * settles and the main thread never yields — which presents as a browser
		 * test that hangs rather than as a visibly broken page.
		 */
		height: var(--row-height, auto);
		min-height: 0;
	}
	@media (max-width: 860px) {
		.cell {
			grid-column: span 12;
		}
	}

	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.6rem;
	}
	.kpi {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 0.55rem 0.7rem;
		background: var(--bg);
	}
	.kpi .label {
		font-size: 0.7rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.kpi .value {
		font-size: 1.4rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}
	.kpi .change {
		font-size: 0.74rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.kpi .change em {
		font-style: normal;
		margin-left: 0.3rem;
	}
	.change.good {
		color: var(--good);
	}
	.change.bad {
		color: var(--bad);
	}

	.panel {
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--bg);
		height: 100%;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.panel-head.thin {
		padding: 0.3rem 0.7rem;
	}
	.panel-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.7rem;
		border-bottom: 1px solid var(--line);
	}
	.panel-head h4 {
		margin: 0;
		font-size: 0.82rem;
		font-weight: 600;
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		flex-wrap: wrap;
		min-width: 0;
	}
	.by {
		font-weight: 400;
		font-size: 0.7rem;
		color: var(--muted);
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
		white-space: nowrap;
	}
	.ghost:hover {
		border-color: var(--line);
		color: var(--text);
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 0.3rem 0.5rem 0.5rem;
	}
	.empty {
		color: var(--muted);
		font-size: 0.8rem;
		padding: 1.5rem 0.5rem;
		text-align: center;
	}
	.prose {
		font-size: 0.82rem;
		line-height: 1.55;
		color: var(--muted);
		margin: 0 0 0.6rem;
		max-width: 82ch;
	}

	.sql {
		margin: 0;
		border-top: 1px solid var(--line);
		padding: 0.6rem 0.7rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--muted);
		overflow-x: auto;
		white-space: pre;
		background: var(--panel);
		border-radius: 0 0 6px 6px;
	}

	ul.board {
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		overflow-y: auto;
		flex: 1;
	}
	ul.board li {
		display: flex;
		gap: 0.1rem;
	}
	ul.board .value {
		position: relative;
		flex: 1;
		font: inherit;
		font-size: 0.78rem;
		text-align: left;
		border: none;
		background: transparent;
		color: var(--text);
		padding: 0.26rem 0.4rem;
		border-radius: 4px;
		cursor: pointer;
		display: grid;
		/* The name gets what is left, but never less than enough to be a name —
		   "EM…" is not a label. */
		grid-template-columns: minmax(5rem, 1fr) auto auto auto;
		gap: 0.45rem;
		align-items: center;
		overflow: hidden;
	}
	ul.board .bar {
		position: absolute;
		inset: 2px auto 2px 0;
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		border-radius: 3px;
	}
	ul.board .name,
	ul.board .num,
	ul.board .share,
	ul.board .trend {
		position: relative;
	}
	ul.board .name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	ul.board .num {
		font-variant-numeric: tabular-nums;
	}
	ul.board .share,
	ul.board .trend {
		font-size: 0.7rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.trend.good {
		color: var(--good);
	}
	.trend.bad {
		color: var(--bad);
	}
	ul.board li.selected .value {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.minus {
		font: inherit;
		border: none;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		padding: 0 0.35rem;
		opacity: 0;
	}
	ul.board li:hover .minus {
		opacity: 1;
	}

	.shelves {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		align-items: center;
		padding: 0.45rem 0.7rem;
		border-bottom: 1px dotted var(--line);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.72rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.12rem 0.2rem 0.12rem 0.55rem;
		color: var(--muted);
		background: var(--bg);
	}
	.chip.on {
		color: var(--text);
		border-color: var(--accent);
	}
	.chip button {
		font: inherit;
		font-size: 0.7rem;
		border: none;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		border-radius: 999px;
		width: 1.15rem;
		height: 1.15rem;
		line-height: 1;
	}
	.chip button.active {
		background: var(--accent);
		color: #fff;
	}
	.chip.measure {
		cursor: pointer;
		padding: 0.12rem 0.55rem;
	}
	.chip.measure.on {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.divider {
		width: 1px;
		height: 1.1rem;
		background: var(--line);
		margin: 0 0.25rem;
	}

	.grid-wrap {
		overflow: auto;
		flex: 1;
		min-height: 0;
	}
	table.pivot,
	table.plain {
		border-collapse: collapse;
		font-size: 0.76rem;
		width: 100%;
	}
	table.pivot th,
	table.pivot td,
	table.plain th,
	table.plain td {
		padding: 0.25rem 0.55rem;
		border-bottom: 1px solid var(--line);
		text-align: right;
		white-space: nowrap;
	}
	table.pivot thead th,
	table.plain thead th {
		font-weight: 600;
		color: var(--muted);
		font-size: 0.72rem;
		position: sticky;
		top: 0;
		background: var(--bg);
	}
	table.pivot tbody th,
	table.pivot .corner {
		text-align: left;
		font-weight: 500;
	}
	table.pivot td {
		font-variant-numeric: tabular-nums;
	}
	table.pivot .total,
	table.pivot tr.total th {
		font-weight: 600;
		background: color-mix(in srgb, var(--accent) 7%, transparent);
	}
	tr.measures th {
		font-weight: 400;
		font-size: 0.68rem;
	}
	.foot {
		margin: 0;
		padding: 0.35rem 0.7rem 0.5rem;
		font-size: 0.7rem;
		color: var(--muted);
		border-top: 1px dotted var(--line);
	}

	.notebook .body {
		padding: 0.7rem;
	}

	.provenance {
		margin-top: 0.8rem;
		font-size: 0.72rem;
		color: var(--muted);
	}

	@media print {
		.controls,
		.ghost,
		.minus,
		.shelves,
		.clear,
		.notebook {
			display: none;
		}
	}
</style>
