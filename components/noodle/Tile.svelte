<script>
	/**
	 * One view on a dashboard.
	 *
	 * A tile is the *presentation* half of noodle: it takes a specification and
	 * shows it. The authoring half — shelves, Show Me, pill menus — stays in the
	 * worksheet and is opened over the top when a tile is edited, so there is one
	 * place where a view is built and one place where it is drawn.
	 *
	 * The tile draws whatever mark the spec resolves to, and reports clicks so the
	 * dashboard can cross-filter. It does not know about the filter context it is
	 * running under; the dashboard merges that in before handing the spec over.
	 */
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';

	import { buildChartOption, buildSeriesData } from './engine/encode.js';
	import { resolveMark } from './engine/showme.js';
	import { createSequencer, runSpec } from './engine/runner.js';
	import { detectMode } from './engine/theme.js';

	export let catalog = null;
	/** The spec to run — already carrying the dashboard's filter context. */
	export let spec = null;
	export let cube = null;
	export let cubeClient = null;
	export let stats = {};
	export let height = 260;
	/** Values selected on *this* tile, highlighted rather than filtered out. */
	export let highlight = null;
	/** Filters the dashboard could not route here, so the tile can say so. */
	export let ignored = [];

	const dispatch = createEventDispatcher();
	const sequencer = createSequencer();

	let rows = [];
	let columns = [];
	let warnings = [];
	let error = null;
	let loading = false;
	let mode = 'light';
	let ready = false;

	let chartEl;
	let chart = null;
	let echarts = null;
	let fmt = (v) => String(v ?? '');

	onMount(async () => {
		if (!browser) return;
		mode = detectMode();
		const [ec, formatting] = await Promise.all([
			import('echarts'),
			import('@evidence-dev/component-utilities/formatting')
		]);
		echarts = ec;
		fmt = (value, format) => {
			if (value === null || value === undefined) return '—';
			try {
				return formatting.fmt(value, format ?? 'num0');
			} catch {
				return String(value);
			}
		};
		ready = true;
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		chart?.dispose();
	});

	/* ------------------------------------------------------------- the run -- */

	let pending = 0;

	const run = async () => {
		if (!browser || !catalog || !spec) return;
		pending++;
		loading = true;
		error = null;
		try {
			const result = await sequencer.run(() => runSpec({ catalog, spec, cube, cubeClient }));
			if (result === null) return;
			rows = result.rows;
			columns = result.columns;
			warnings = result.compiled?.warnings ?? [];
		} catch (e) {
			error = e?.message ?? String(e);
			rows = [];
			columns = [];
		} finally {
			loading = --pending > 0;
		}
		await tick();
		render();
	};

	// The spec object is replaced, never mutated, so identity is the signal.
	$: if (ready && catalog && spec) run();

	$: mark = catalog && spec ? resolveMark(catalog, spec, stats) : 'table';
	$: measureColumns = columns.filter((c) => c.role === 'measure');

	/* ------------------------------------------------------------- drawing -- */

	/**
	 * Dim the marks the selection excludes.
	 *
	 * The tile that raised a cross-filter keeps all of its data — filtering it
	 * would remove the bars you would have to click to change your mind. So the
	 * selection is shown by contrast instead, which is also how it reads: "this
	 * slice of a whole I can still see".
	 */
	const applyHighlight = (option, categories) => {
		if (!highlight?.values?.length || !option?.series) return option;
		const selected = new Set(highlight.values.map(String));
		const flags = categories.map((c) => selected.has(String(c)));
		if (!flags.some(Boolean)) return option;

		for (const series of option.series) {
			if (!Array.isArray(series.data)) continue;
			series.data = series.data.map((datum, i) => {
				const opacity = flags[i] ? 1 : 0.22;
				return datum !== null && typeof datum === 'object' && !Array.isArray(datum)
					? { ...datum, itemStyle: { ...(datum.itemStyle ?? {}), opacity } }
					: { value: datum, itemStyle: { opacity } };
			});
		}
		return option;
	};

	const render = () => {
		if (!browser || !echarts || !chartEl) return;
		if (mark === 'table' || mark === 'bigvalue' || !rows.length) {
			chart?.dispose();
			chart = null;
			return;
		}

		const option = buildChartOption({ mark, rows, columns, spec, mode, fmt });
		if (!option) {
			chart?.dispose();
			chart = null;
			return;
		}

		const { categories } = buildSeriesData({ rows, columns, spec });

		if (!chart || chart.isDisposed?.()) {
			chart = echarts.init(chartEl, null, { renderer: 'canvas' });
			chart.on('click', onClick);
		}
		chart.setOption(applyHighlight(option, categories), true);
		chart.resize();
	};

	$: if (browser && chartEl && echarts && (rows || mark || mode || highlight)) render();

	let resizeObserver = null;
	$: if (browser && chartEl && !resizeObserver) {
		resizeObserver = new ResizeObserver(() => chart?.resize());
		resizeObserver.observe(chartEl);
	}

	/* ---------------------------------------------------------- interaction -- */

	/**
	 * A click is a selection, not a filter — the dashboard decides what it means.
	 *
	 * The value reported is the raw category, not the axis label: labels are
	 * formatted for reading ("Mar 21"), and a filter built from one would match
	 * nothing.
	 */
	const onClick = (event) => {
		const { categories, axisColumn } = buildSeriesData({ rows, columns, spec });
		if (!axisColumn) return;

		let value;
		if (mark === 'point') {
			// A scatter mark carries its detail label in the fourth slot.
			value = Array.isArray(event.value) ? event.value[3] : undefined;
			const match = rows.find((r) => String(r[axisColumn.alias]) === String(value));
			value = match ? match[axisColumn.alias] : undefined;
		} else if (mark === 'heatmap') {
			value = Array.isArray(event.value) ? categories[event.value[0]] : undefined;
		} else {
			value = categories[event.dataIndex];
		}
		if (value === undefined) return;

		dispatch('select', {
			fieldId: axisColumn.pill.fieldId,
			values: [value],
			label: `${axisColumn.label ?? axisColumn.alias}: ${value}`
		});
	};

	const dateCell = (value) => {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? String(value ?? '—') : d.toISOString().slice(0, 10);
	};
</script>

<!-- A chart is centred in the space it is given; a table starts at the top and
     grows down, because a short table floating mid-tile reads as a rendering
     accident rather than a small result. -->
<div class="tile-body" class:top={mark === 'table'} style="min-height:{height}px">
	{#if error}
		<div class="state error">
			<strong>This tile could not run</strong>
			<p>{error}</p>
		</div>
	{:else if !spec}
		<div class="state">
			<strong>Empty tile</strong>
			<p>Edit it to put a field on a shelf.</p>
		</div>
	{:else if !rows.length && !loading}
		<div class="state">
			<strong>No rows</strong>
			<p>
				{#if ignored.length}
					Nothing matched. Note that {ignored.length} page filter{ignored.length > 1 ? 's do' : ' does'} not
					reach this tile's source.
				{:else}
					Nothing matched the current filters.
				{/if}
			</p>
		</div>
	{:else if mark === 'bigvalue'}
		<div class="bigvalues">
			{#each measureColumns as column}
				<div>
					<span class="bv-title">{column.label}</span>
					<span class="bv-value">{fmt(rows[0]?.[column.alias], column.format)}</span>
				</div>
			{/each}
		</div>
	{:else if mark === 'table'}
		<div class="table-wrap" style="max-height:{height}px">
			<table>
				<thead>
					<tr>
						{#each columns as column}
							<th class:num={column.role === 'measure'}>{column.label ?? column.alias}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows.slice(0, 100) as row}
						<tr>
							{#each columns as column}
								<td class:num={column.role === 'measure'}>
									{column.role === 'measure'
										? fmt(row[column.alias], column.format)
										: column.dataType === 'date'
											? dateCell(row[column.alias])
											: (row[column.alias] ?? '—')}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="chart" bind:this={chartEl} style="height:{height}px"></div>
	{/if}

	{#if loading}<span class="loading">Running…</span>{/if}
</div>

{#if ignored.length}
	<!-- A dashboard whose tiles quietly ignore a filter is a dashboard that lies:
	     filtered and unfiltered numbers sit side by side and look comparable. -->
	<p class="tile-note">
		Not filtered by {ignored.length} of the page filters — no path from this tile's source to
		{ignored.map((f) => catalog?.byId?.[f.fieldId]?.name ?? f.fieldId).join(', ')}.
	</p>
{/if}
{#each warnings.slice(0, 1) as warning}
	<p class="tile-note">{warning}</p>
{/each}

<style>
	.tile-body { position: relative; display: flex; flex-direction: column; justify-content: center; }
	.tile-body.top { justify-content: flex-start; }
	.chart { width: 100%; }

	.state {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 4px; flex: 1; color: var(--nd-muted); text-align: center; padding: 16px;
	}
	.state strong { color: var(--nd-text); font-size: 13px; }
	.state p { margin: 0; max-width: 32ch; font-size: 11px; line-height: 1.45; }
	.state.error strong { color: #d03b3b; }

	.loading {
		position: absolute; top: 6px; right: 8px; font-size: 10px; color: var(--nd-muted);
		background: var(--nd-bg); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--nd-border);
	}

	.bigvalues { display: flex; gap: 28px; padding: 16px; flex-wrap: wrap; }
	.bv-title { display: block; font-size: 11px; color: var(--nd-muted); }
	.bv-value { display: block; font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }

	.table-wrap { overflow: auto; }
	table { width: 100%; border-collapse: collapse; font-size: 11px; }
	th, td { padding: 3px 8px; border-bottom: 1px solid var(--nd-border); text-align: left; white-space: nowrap; }
	th { position: sticky; top: 0; background: var(--nd-bg); font-weight: 600; color: var(--nd-muted); }
	th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }

	.tile-note {
		margin: 0; padding: 4px 10px 8px; font-size: 10px; line-height: 1.4; color: var(--nd-muted);
	}
</style>
