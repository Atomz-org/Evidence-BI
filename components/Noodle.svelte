<script>
	/**
	 * noodle — an exploration surface for Evidence.
	 *
	 * Fields are dragged onto shelves; the shelves are the specification; the
	 * specification compiles to SQL and to a chart. Nothing here is scripted by
	 * the person using it: filters, tooltips, click-to-highlight and the mark
	 * type all fall out of where the fields were dropped.
	 *
	 *   <Noodle
	 *     tables={['dbt_semantic.orders', 'dbt_semantic.customers']}
	 *     relationships={[{ from: '...', to: '...', on: [['customer_id','customer_id']] }]}
	 *   />
	 */
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';

	import { buildCatalog } from './noodle/engine/catalog.js';
	import {
		ALL_SHELVES,
		LIST_SHELVES,
		SINGLE_SHELVES,
		allPills,
		canDrop,
		dropField,
		emptySpec,
		movePill,
		pillLabel,
		removePill,
		transpose,
		updatePill
	} from './noodle/engine/spec.js';
	import { TABLE_CALCS } from './noodle/engine/tablecalc.js';
	import { MARKS, blockedReason, recommend, resolveMark } from './noodle/engine/showme.js';
	import { buildChartOption } from './noodle/engine/encode.js';
	import { toEvidenceMarkdown } from './noodle/engine/export.js';
	import { detectMode, reliefRequired } from './noodle/engine/theme.js';
	import { AGGREGATIONS, DATE_PARTS } from './noodle/engine/sql.js';
	import { createSequencer, hasView, runSpec } from './noodle/engine/runner.js';
	import { catalogFromCubeMeta, createCubeClient, toCubeSql } from './noodle/engine/cube.js';
	import { RILL } from './rill/model.generated.js';
	import {
		catalogFromMetricsView,
		createViewSql,
		viewName as rillViewName
	} from './rill/engine/metrics.js';

	/** Fully qualified tables to expose. */
	export let tables = [];
	/** Logical links between them — the relationship layer. */
	export let relationships = [];
	/** Per-field overrides, keyed `schema.table.column`. */
	export let fields = {};
	/** Display names per table. */
	export let labels = {};
	/** Height of the chart canvas. */
	export let height = 420;
	/**
	 * Height of the field list once the surface stacks into one column.
	 *
	 * Fixed rather than proportional because in the stacked layout the field list
	 * sits *above* the shelves, and a list that grows with the catalog pushes the
	 * thing you are dragging onto off the screen. The default suits a handful of
	 * columns; a semantic layer with a dozen governed measures wants more, or half
	 * its fields are below a fold nobody thinks to scroll.
	 */
	export let fieldListHeight = 200;
	/** Start with these fields on shelves: { columns: [...], rows: [...] }. */
	export let initial = null;
	/**
	 * Use Cube as the semantic layer instead of introspecting the warehouse:
	 * `{ apiUrl, token?, viewsOnly? }`.
	 *
	 * With this set, the catalog *is* Cube's model — measures keep the
	 * aggregation the model gives them, joins come from Cube's join graph, and
	 * the shelves compile to a Cube query rather than to SQL. Without it,
	 * everything behaves exactly as before.
	 */
	export let cube = null;
	/**
	 * Use a Rill metrics view as the semantic layer: `{ explore }` or
	 * `{ metricsView }`, naming a resource in `rill/`.
	 *
	 * Unlike the Cube path this still compiles to SQL and still runs in
	 * duckdb-wasm — what changes is where the field list comes from. Measures
	 * arrive carrying the expression the metrics view declares, so dragging
	 * "Average order value" onto a shelf produces the governed ratio rather than
	 * an average of a column that happens to be named like one. The aggregation
	 * menu is closed for those fields, because the semantic layer has already
	 * answered that question.
	 */
	export let rill = null;
	/**
	 * The view specification.
	 *
	 * Bindable, so a dashboard can own its tiles' specs and open this surface as
	 * the tile editor — one authoring implementation rather than two. Left alone,
	 * the worksheet owns it as before.
	 */
	export let spec = emptySpec();
	/**
	 * A ready-made catalog, used instead of introspecting.
	 *
	 * A dashboard builds one and shares it across every tile. Introspecting the
	 * same warehouse once per tile is slow, and worse, it is how two tiles come to
	 * disagree about whether a column is a measure.
	 */
	export let catalog = null;
	/** Shared cardinality hints — Show Me's variant choice depends on them. */
	export let stats = {};

	let rows = [];
	let compiled = { sql: null, columns: [], warnings: [] };
	let displayColumns = [];
	let loading = false;
	let error = null;
	let mode = 'light';

	let chartEl;
	let chart = null;
	let echarts = null;
	let fmt = (v) => String(v ?? '');

	let cubeClient = null;
	let cubeSql = null;
	let rillView = null;

	/**
	 * `{ explore }` names a dashboard and inherits its metrics view; `{ metricsView }`
	 * names the view directly, for a worksheet that is not tied to a dashboard.
	 */
	const resolveRillView = (config) => {
		const name = config.metricsView ?? RILL.explores[config.explore]?.metricsView;
		const view = name ? RILL.metricsViews[name] : null;
		if (!view) {
			throw new Error(
				`No Rill metrics view for ${JSON.stringify(config)} — ` +
					`known views: ${Object.keys(RILL.metricsViews).join(', ') || 'none'}`
			);
		}
		return view;
	};

	let search = '';
	let dragging = null;
	let dragOverShelf = null;
	let openPill = null;
	let showSql = false;
	let copied = false;

	/* ------------------------------------------------------------- startup -- */

	let themeObserver = null;

	onMount(async () => {
		if (!browser) return;
		mode = detectMode();

		const [{ query }, formatting, ec] = await Promise.all([
			import('@evidence-dev/universal-sql/client-duckdb'),
			import('@evidence-dev/component-utilities/formatting'),
			import('echarts')
		]);
		echarts = ec;
		fmt = (value, format) => {
			if (value === null || value === undefined) return '—';
			try {
				return format ? formatting.fmt(value, format) : formatting.fmt(value, 'num0');
			} catch {
				return String(value);
			}
		};

		try {
			// Cube already knows the model — no introspection, and no guessing at
			// which columns are measures or how they aggregate.
			if (cube) cubeClient = createCubeClient(cube);

			// A Rill metrics view resolves to one DuckDB relation, created here so a
			// worksheet and the governed dashboard are reading the same thing rather
			// than two copies of the same intent.
			if (rill) {
				rillView = resolveRillView(rill);
				await query(createViewSql(rillView, RILL.models));
			}

			// A catalog handed in by a parent is already built; introspecting again
			// would be the same work per tile and could disagree with itself.
			if (!catalog) {
				catalog = cube
					? catalogFromCubeMeta(await cubeClient.meta(), { viewsOnly: cube.viewsOnly })
					: rillView
						? catalogFromMetricsView(rillView, RILL.models)
						: await buildCatalog(query, { tables, relationships, fields, labels });
				// Cardinality is introspection over raw columns; a metrics view's
				// measures are expressions with no column to count, so Show Me falls
				// back to its shape rules there, as it does for Cube.
				if (!cube && !rill) await loadCardinality(query);
			}

			// A spec arriving as a prop is somebody's saved view. Only seed a fresh
			// one when the shelves are genuinely empty, or opening a tile in the
			// editor would clear the tile.
			if (!allPills({ ...emptySpec(), ...(spec ?? {}) }).length) {
				spec = { ...emptySpec(cube ? null : rillView ? rillViewName(rillView) : (tables[0] ?? null)) };
				if (initial) applyInitial();
			}
		} catch (e) {
			error = e?.message ?? String(e);
		}

		// Repaint when the theme switcher flips the surface underneath us. Svelte
		// only honours a cleanup returned synchronously from onMount, and this
		// callback is async — so the observer is torn down from onDestroy instead.
		themeObserver = new MutationObserver(() => {
			const next = detectMode();
			if (next !== mode) {
				mode = next;
				render();
			}
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'data-theme']
		});
	});

	const applyInitial = () => {
		for (const shelf of ALL_SHELVES) {
			for (const fieldId of [].concat(initial[shelf] ?? [])) {
				const field = catalog.byId[fieldId];
				if (field) spec = dropField(spec, catalog, field, shelf);
			}
		}
	};

	/**
	 * Distinct counts drive Show Me's variant choice — a bar chart is right up to
	 * a point and a table after it, and only the data knows where that is.
	 */
	const loadCardinality = async (query) => {
		const dimensions = catalog.fields.filter((f) => f.role === 'dimension' && f.dataType !== 'date');
		if (!dimensions.length) return;
		const next = {};
		await Promise.all(
			dimensions.slice(0, 40).map(async (field) => {
				try {
					const [row] = await query(
						`select count(distinct "${field.column}") as n from "${field.table.split('.')[0]}"."${field.table.split('.')[1]}"`
					);
					next[field.id] = { distinct: Number(row?.n ?? 0) };
				} catch {
					/* a column we cannot count simply has no hint */
				}
			})
		);
		stats = next;
	};

	/* ---------------------------------------------------------- the query -- */

	// One specification, two backends. Cube resolves joins, security context and
	// pre-aggregations; DuckDB compiles and runs SQL in the browser. Both go
	// through the shared runner so a dashboard tile and this worksheet cannot
	// drift apart on the details.
	const sequencer = createSequencer();
	let pending = 0;

	const runQuery = async () => {
		if (!browser || !catalog) return;

		pending++;
		loading = true;
		error = null;
		try {
			const result = await sequencer.run(() => runSpec({ catalog, spec, cube, cubeClient }));
			if (result === null) return; // a newer edit already superseded this
			compiled = result.compiled;
			rows = result.rows;
			displayColumns = result.columns;
			if (result.empty) cubeSql = null;
		} catch (e) {
			error = e?.message ?? String(e);
			rows = [];
		} finally {
			loading = --pending > 0;
		}
		await tick();
		render();
	};

	/**
	 * The SQL Cube would run for the current view — fetched on demand, because it
	 * is the audit trail rather than something the chart needs.
	 */
	const loadCubeSql = async () => {
		if (!cube || !compiled.query) return;
		try {
			const response = await cubeClient.sql(compiled.query);
			cubeSql = response?.sql?.sql?.[0] ?? null;
		} catch (e) {
			cubeSql = `-- Cube could not return SQL for this query: ${e?.message ?? e}`;
		}
	};

	// Re-run whenever the specification changes — the shelves are the query.
	$: if (catalog && spec) runQuery();
	// Svelte tracks named variables, not what a function reads — so the template
	// gates read this, not hasView(compiled) directly.
	$: viewReady = hasView(compiled, cube);

	$: mark = catalog ? resolveMark(catalog, spec, stats) : 'table';
	$: suggestions = catalog ? recommend(catalog, spec, stats) : [];
	$: seriesCount = spec.color ? new Set(rows.map((r) => r[colorAlias])).size : 1;
	$: colorAlias = spec.color ? displayColumns.find((c) => c.pill.key === spec.color?.key)?.alias : null;
	$: needsRelief = reliefRequired(mode, seriesCount);
	// Explain the mark that is actually drawn, not the one ranked first — those
	// differ the moment someone overrides the recommendation, and a card that
	// keeps describing a chart you are not looking at is worse than none.
	$: activeReason =
		suggestions.find((s) => s.mark === mark)?.reason ?? suggestions[0]?.reason ?? null;
	/**
	 * The exit into BI-as-code. On DuckDB the exported query is the one that just
	 * ran; on Cube it is the equivalent statement for Cube's SQL API, which an
	 * Evidence source can run through the existing postgres connector — so the
	 * exported page keeps going through the semantic layer rather than around it.
	 */
	$: exportMarkdown = !catalog
		? ''
		: cube
			? (() => {
					const translated = toCubeSql(catalog, spec);
					return translated.sql
						? toEvidenceMarkdown({
								catalog,
								spec,
								compiled: { sql: translated.sql, columns: translated.columns },
								mark
							})
						: '';
				})()
			: compiled.sql
				? toEvidenceMarkdown({ catalog, spec, compiled, mark })
				: '';

	/* ------------------------------------------------------------- drawing -- */

	const render = () => {
		if (!browser || !echarts || !chartEl) return;

		if (mark === 'table' || mark === 'bigvalue' || !rows.length) {
			chart?.dispose();
			chart = null;
			return;
		}

		const option = buildChartOption({ mark, rows, columns: displayColumns, spec, mode, fmt });
		if (!option) {
			chart?.dispose();
			chart = null;
			return;
		}

		if (!chart || chart.isDisposed?.()) {
			chart = echarts.init(chartEl, null, { renderer: 'canvas' });
			chart.on('click', onMarkClick);
		}
		chart.setOption(option, true);
		chart.resize();
	};

	$: if (browser && chartEl && echarts && (rows || mark || mode)) render();

	// The surface is full-bleed, so its width tracks the viewport rather than the
	// prose column — the chart has to follow it.
	let resizeObserver = null;
	$: if (browser && chartEl && !resizeObserver) {
		resizeObserver = new ResizeObserver(() => chart?.resize());
		resizeObserver.observe(chartEl);
	}
	onDestroy(() => {
		resizeObserver?.disconnect();
		themeObserver?.disconnect();
		chart?.dispose();
	});

	/**
	 * Click-to-filter. Clicking a mark adds the category it represents as a
	 * filter — the no-code equivalent of writing a WHERE clause, and reversible
	 * from the filter shelf.
	 */
	const onMarkClick = (event) => {
		const axisColumn = displayColumns.find(
			(c) => c.role === 'dimension' && c.pill.key !== spec.color?.key
		);
		if (!axisColumn) return;

		const clicked = rows.find(
			(r, i) => i === event.dataIndex || String(r[axisColumn.alias]) === String(event.name)
		);
		const value = clicked?.[axisColumn.alias];
		if (value === undefined) return;

		addFilter(axisColumn.pill.fieldId, 'in', [value]);
	};

	/* ------------------------------------------------------- shelf actions -- */

	const onDragStart = (event, payload) => {
		dragging = payload;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', payload.fieldId ?? payload.pillKey ?? '');
	};

	const onDrop = (event, shelf) => {
		event.preventDefault();
		dragOverShelf = null;
		if (!dragging || !catalog) return;

		if (dragging.pillKey) {
			spec = movePill(spec, dragging.pillKey, shelf);
		} else {
			const field = catalog.byId[dragging.fieldId];
			if (!field) return;
			const check = canDrop(catalog, field, shelf);
			if (!check.ok) {
				error = check.reason;
				dragging = null;
				return;
			}
			spec = dropField(spec, catalog, field, shelf);
		}
		dragging = null;
	};

	const addFilter = (fieldId, op, values) => {
		const field = catalog.byId[fieldId];
		if (!field) return;
		const existing = spec.filters.findIndex((f) => f.fieldId === fieldId && f.op === op);
		const filter = { fieldId, role: field.role, op, values, agg: field.defaultAgg };
		spec = {
			...spec,
			filters:
				existing >= 0
					? spec.filters.map((f, i) => (i === existing ? filter : f))
					: [...spec.filters, filter]
		};
	};

	const removeFilter = (index) => {
		spec = { ...spec, filters: spec.filters.filter((_, i) => i !== index) };
	};

	const setMark = (next) => {
		spec = { ...spec, mark: spec.mark === next ? 'auto' : next };
	};

	const copyExport = async () => {
		try {
			await navigator.clipboard.writeText(exportMarkdown);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			showSql = true;
		}
	};

	const clearAll = () => {
		spec = emptySpec(tables[0] ?? null);
	};

	/* ---------------------------------------------------------- field list -- */

	$: visibleFields = (catalog?.fields ?? []).filter((f) =>
		search ? f.name.toLowerCase().includes(search.toLowerCase()) : true
	);
	$: groupedFields = (catalog?.tables ?? []).map((table) => ({
		table,
		dimensions: visibleFields.filter((f) => f.table === table.name && f.role === 'dimension'),
		measures: visibleFields.filter((f) => f.table === table.name && f.role === 'measure')
	}));

	const SHELF_LABEL = {
		columns: 'Columns',
		rows: 'Rows',
		color: 'Color',
		size: 'Size',
		label: 'Label',
		detail: 'Detail',
		tooltip: 'Tooltip'
	};

	// Derived, not a function call in the template: Svelte tracks the variables an
	// expression names, not what a function reads, so `pillsOn(shelf)` would go
	// stale the moment a pill was added.
	$: shelfPills = Object.fromEntries(
		ALL_SHELVES.map((shelf) => [
			shelf,
			SINGLE_SHELVES.includes(shelf) ? (spec[shelf] ? [spec[shelf]] : []) : (spec[shelf] ?? [])
		])
	);
</script>

<div class="noodle-outer">
<div class="noodle" class:dark={mode === 'dark'} style="--nd-fields-stacked: {fieldListHeight}px">
	<!-- ------------------------------------------------------- data panel -- -->
	<aside class="panel data-panel">
		<div class="panel-head">
			<span class="panel-title">Data</span>
			<input class="search" bind:value={search} placeholder="Search fields" aria-label="Search fields" />
		</div>

		{#if !catalog}
			<p class="muted pad">Connecting to the semantic layer…</p>
		{:else}
			<div class="scroll">
				{#each groupedFields as group}
					<div class="table-group">
						<div class="table-name">{group.table.label}</div>

						{#if group.dimensions.length}
							<div class="role-label">Dimensions</div>
							{#each group.dimensions as field}
								<div
									class="field dim"
									draggable="true"
									role="button"
									tabindex="0"
									on:dragstart={(e) => onDragStart(e, { fieldId: field.id })}
									title={field.description ?? `${field.dataType} · ${field.column}`}
								>
									<span class="glyph">{field.dataType === 'date' ? '📅' : 'Abc'}</span>
									<span class="field-name">{field.name}</span>
									{#if stats[field.id]?.distinct}
										<span class="count">{stats[field.id].distinct}</span>
									{/if}
								</div>
							{/each}
						{/if}

						{#if group.measures.length}
							<div class="role-label">Measures</div>
							{#each group.measures as field}
								<div
									class="field measure"
									draggable="true"
									role="button"
									tabindex="0"
									on:dragstart={(e) => onDragStart(e, { fieldId: field.id })}
									title={field.description ?? `${field.dataType} · ${field.column}`}
								>
									<span class="glyph">#</span>
									<span class="field-name">{field.name}</span>
								</div>
							{/each}
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</aside>

	<!-- ----------------------------------------------------------- canvas -- -->
	<section class="canvas">
		<div class="shelves">
			{#each ['columns', 'rows'] as shelf}
				<div class="shelf-row">
					<span class="shelf-label">{SHELF_LABEL[shelf]}</span>
					<div
						class="shelf"
						class:over={dragOverShelf === shelf}
						role="list"
						on:dragover|preventDefault={() => (dragOverShelf = shelf)}
						on:dragleave={() => (dragOverShelf = null)}
						on:drop={(e) => onDrop(e, shelf)}
					>
						{#each shelfPills[shelf] as pill (pill.key)}
							<span
								class="pill"
								class:measure={pill.role === 'measure'}
								role="listitem"
								draggable="true"
								on:dragstart={(e) => onDragStart(e, { pillKey: pill.key })}
							>
								<button class="pill-label" on:click={() => (openPill = openPill === pill.key ? null : pill.key)}>
									{pillLabel(catalog, pill)}
								</button>
								<button class="pill-x" on:click={() => (spec = removePill(spec, pill.key))} aria-label="Remove">×</button>

								{#if openPill === pill.key}
									{@const pillField = catalog?.byId[pill.fieldId]}
									<div class="menu" role="menu">
										{#if pill.role === 'measure'}
											<div class="menu-head">Aggregate</div>
											{#if pillField?.semantic}
												<!--
													A modelled measure's aggregation is not the shelf's to choose.
													Offering the menu and then ignoring the choice is worse than not
													offering it: the compiler's warning arrives after the fact, and
													until it does the pill reads as though the setting took.
												-->
												<p class="menu-note">
													{pillField.aggLocked ?? 'Decided by the semantic layer, not by this shelf.'}
												</p>
											{:else}
												{#each Object.entries(AGGREGATIONS) as [key, agg]}
													<button
														class="menu-item"
														class:active={pill.agg === key}
														on:click={() => (spec = updatePill(spec, pill.key, { agg: key }))}
													>{agg.label}</button>
												{/each}
											{/if}

											<div class="menu-head">Table calculation</div>
											<button
												class="menu-item"
												class:active={!pill.calc}
												on:click={() => (spec = updatePill(spec, pill.key, { calc: null }))}
											>None</button>
											{#each Object.entries(TABLE_CALCS) as [key, calc]}
												<button
													class="menu-item"
													class:active={pill.calc?.type === key}
													on:click={() => (spec = updatePill(spec, pill.key, { calc: { type: key, window: 3 } }))}
												>{calc.label}</button>
											{/each}
										{:else}
											{#if catalog.byId[pill.fieldId]?.dataType === 'date'}
												<div class="menu-head">Date grain</div>
												{#each Object.entries(DATE_PARTS) as [key, part]}
													<button
														class="menu-item"
														class:active={pill.datePart === key}
														on:click={() => (spec = updatePill(spec, pill.key, { datePart: key }))}
													>{part.label}</button>
												{/each}
											{/if}
											<div class="menu-head">Sort</div>
											{#each [['asc', 'Ascending'], ['desc', 'Descending']] as [dir, dirLabel]}
												<button
													class="menu-item"
													class:active={pill.sort?.dir === dir}
													on:click={() => (spec = updatePill(spec, pill.key, { sort: { dir, by: 'value' } }))}
												>{dirLabel} by value</button>
											{/each}
											<button
												class="menu-item"
												class:active={!pill.sort}
												on:click={() => (spec = updatePill(spec, pill.key, { sort: null }))}
											>Data order</button>
										{/if}
										<button class="menu-close" on:click={() => (openPill = null)}>Done</button>
									</div>
								{/if}
							</span>
						{/each}

						{#if !shelfPills[shelf].length}
							<span class="drop-hint">Drop a field here</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<div class="viz" style="min-height:{height}px">
			{#if error}
				<div class="state error">
					<strong>That view could not be built</strong>
					<p>{error}</p>
				</div>
			{:else if !viewReady}
				<div class="state">
					<strong>Start with a field</strong>
					<p>Drag a dimension onto Columns and a measure onto Rows. The chart picks itself.</p>
				</div>
			{:else if mark === 'table'}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>{#each displayColumns as column}<th class:num={column.role === 'measure'}>{column.label ?? column.alias}</th>{/each}</tr>
						</thead>
						<tbody>
							{#each rows.slice(0, 200) as row}
								<tr>
									{#each displayColumns as column}
										<td class:num={column.role === 'measure'}>
											{column.role === 'measure'
												? fmt(row[column.alias], column.format)
												: column.dataType === 'date'
													? new Date(row[column.alias]).toISOString().slice(0, 10)
													: (row[column.alias] ?? '—')}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
					{#if rows.length > 200}<p class="muted pad">Showing 200 of {rows.length} rows.</p>{/if}
				</div>
			{:else if mark === 'bigvalue'}
				<div class="bigvalues">
					{#each displayColumns.filter((c) => c.role === 'measure') as column}
						<div class="bigvalue">
							<span class="bv-title">{column.label}</span>
							<span class="bv-value">{fmt(rows[0]?.[column.alias], column.format)}</span>
						</div>
					{/each}
				</div>
			{:else}
				<div class="chart" bind:this={chartEl} style="height:{height}px"></div>
			{/if}

			{#if loading}<div class="loading">Running…</div>{/if}
		</div>

		{#each compiled.warnings as warning}
			<p class="warning">{warning}</p>
		{/each}
		{#if needsRelief && mark !== 'table'}
			<p class="warning">
				This palette's aqua, yellow and magenta slots fall below 3:1 on a light surface —
				value labels are on, and the table view stays one click away.
			</p>
		{/if}
		{#if seriesCount > 4 && mark !== 'table'}
			<p class="warning">
				{seriesCount} series on one chart is past what colour can carry. Fold the tail into
				an "Other" bucket, or split this into small multiples — the palette deliberately
				stops at eight hues and does not cycle.
			</p>
		{/if}

		<footer class="foot">
			<button class="ghost" on:click={() => (spec = transpose(spec))} disabled={!viewReady}>Swap rows/columns</button>
			<button class="ghost" on:click={clearAll}>Clear</button>
			<span class="spacer"></span>
			{#if rows.length}<span class="muted">{rows.length} rows</span>{/if}
			<button class="ghost" on:click={() => (showSql = !showSql)} disabled={!viewReady}>
				{showSql ? 'Hide' : 'Show'} source
			</button>
			<button class="primary" on:click={copyExport} disabled={!exportMarkdown}>
				{copied ? 'Copied' : 'Copy as Evidence markdown'}
			</button>
		</footer>

		{#if showSql && exportMarkdown}
			<pre class="sql">{exportMarkdown}</pre>
		{/if}
	</section>

	<!-- ------------------------------------------------------ show me etc -- -->
	<aside class="panel side">
		<div class="card">
			<div class="card-title">Show Me</div>
			<div class="marks">
				{#each Object.entries(MARKS) as [key, definition]}
					{@const blocked = catalog ? blockedReason(catalog, spec, key) : 'Loading'}
					<button
						class="mark"
						class:active={mark === key}
						class:chosen={spec.mark === key}
						disabled={!!blocked}
						title={blocked ?? suggestions.find((s) => s.mark === key)?.reason ?? definition.label}
						on:click={() => setMark(key)}
					>{definition.label}</button>
				{/each}
			</div>
			{#if activeReason}
				<p class="reason"><strong>{MARKS[mark]?.label}.</strong> {activeReason}</p>
			{/if}
		</div>

		<div class="card">
			<div class="card-title">Marks</div>
			{#each SINGLE_SHELVES as shelf}
				<div class="mark-shelf">
					<span class="shelf-label small">{SHELF_LABEL[shelf]}</span>
					<div
						class="shelf tight"
						class:over={dragOverShelf === shelf}
						role="list"
						on:dragover|preventDefault={() => (dragOverShelf = shelf)}
						on:dragleave={() => (dragOverShelf = null)}
						on:drop={(e) => onDrop(e, shelf)}
					>
						{#if spec[shelf]}
							<span class="pill small" class:measure={spec[shelf].role === 'measure'} role="listitem">
								<span class="pill-label">{pillLabel(catalog, spec[shelf])}</span>
								<button class="pill-x" on:click={() => (spec = removePill(spec, spec[shelf].key))} aria-label="Remove">×</button>
							</span>
						{:else}
							<span class="drop-hint small">Drop here</span>
						{/if}
					</div>
				</div>
			{/each}
			{#if spec.color}
				<label class="toggle">
					<input type="checkbox" bind:checked={spec.stacked} /> Stack the series
				</label>
			{/if}
		</div>

		<div class="card">
			<div class="card-title">Filters</div>
			{#if !spec.filters.length}
				<p class="muted small">Click any mark on the chart to filter to it.</p>
			{/if}
			{#each spec.filters as filter, i}
				<div class="filter">
					<span>{catalog?.byId[filter.fieldId]?.name ?? filter.fieldId}</span>
					<span class="muted">{filter.op}</span>
					<span class="filter-values">{(filter.values ?? []).join(', ')}</span>
					<button class="pill-x" on:click={() => removeFilter(i)} aria-label="Remove filter">×</button>
				</div>
			{/each}
		</div>
	</aside>
</div>
</div>

<style>
	.noodle {
		--nd-bg: #ffffff;
		--nd-panel: #fafafa;
		--nd-border: #e4e4e7;
		--nd-text: #18181b;
		--nd-muted: #71717a;
		--nd-dim: #2a78d6;
		--nd-measure: #008300;
		--nd-accent: #eb6834;

		display: grid;
		grid-template-columns: 232px minmax(0, 1fr) 260px;
		gap: 0;
		border: 1px solid var(--nd-border);
		border-radius: 8px;
		overflow: visible;
		background: var(--nd-bg);
		color: var(--nd-text);
		font-size: 13px;
		margin: 1.5rem 0;
		width: 100%;
	}

	/* The surface adapts to the column it is given rather than to the viewport:
	   the same component sits in a full-width workbench page and inside a narrow
	   prose column, and only the container knows which. */
	.noodle-outer {
		container-type: inline-size;
	}
	.noodle.dark {
		--nd-bg: #09090b;
		--nd-panel: #111113;
		--nd-border: #27272a;
		--nd-text: #fafafa;
		--nd-muted: #a1a1aa;
		--nd-dim: #3987e5;
		--nd-measure: #199e70;
	}

	.panel { background: var(--nd-panel); display: flex; flex-direction: column; min-width: 0; }
	.data-panel { border-right: 1px solid var(--nd-border); }
	.side { border-left: 1px solid var(--nd-border); gap: 0; }

	.panel-head { padding: 10px; border-bottom: 1px solid var(--nd-border); }
	.panel-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nd-muted); }
	.search {
		width: 100%; margin-top: 8px; padding: 5px 8px; font-size: 12px;
		border: 1px solid var(--nd-border); border-radius: 5px;
		background: var(--nd-bg); color: var(--nd-text);
	}

	.scroll { overflow-y: auto; max-height: 620px; padding: 6px; }
	.table-group { margin-bottom: 12px; }
	.table-name { font-weight: 600; font-size: 12px; padding: 4px 6px; }
	.role-label {
		font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--nd-muted); padding: 6px 6px 2px;
	}

	.field {
		display: flex; align-items: center; gap: 6px;
		padding: 3px 6px; border-radius: 4px; cursor: grab;
		white-space: nowrap; overflow: hidden;
	}
	.field:hover { background: color-mix(in srgb, var(--nd-dim) 12%, transparent); }
	.field-name { overflow: hidden; text-overflow: ellipsis; }
	.glyph { font-size: 10px; width: 22px; flex: none; color: var(--nd-muted); font-family: ui-monospace, monospace; }
	.field.measure .glyph { color: var(--nd-measure); }
	.field.dim .glyph { color: var(--nd-dim); }
	.count { margin-left: auto; font-size: 10px; color: var(--nd-muted); }

	.canvas { display: flex; flex-direction: column; min-width: 0; }
	.shelves { border-bottom: 1px solid var(--nd-border); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
	.shelf-row { display: flex; align-items: center; gap: 8px; }
	.shelf-label { font-size: 11px; color: var(--nd-muted); width: 58px; flex: none; text-transform: uppercase; letter-spacing: 0.05em; }
	.shelf-label.small { width: 44px; }

	.shelf {
		flex: 1; min-height: 30px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center;
		padding: 3px 5px; border: 1px dashed transparent; border-radius: 5px;
	}
	.shelf.over { border-color: var(--nd-dim); background: color-mix(in srgb, var(--nd-dim) 8%, transparent); }
	.shelf.tight { min-height: 26px; }
	.drop-hint { color: var(--nd-muted); font-size: 11px; font-style: italic; }
	.drop-hint.small { font-size: 10px; }

	.pill {
		position: relative; display: inline-flex; align-items: center; gap: 2px;
		background: color-mix(in srgb, var(--nd-dim) 16%, transparent);
		border: 1px solid color-mix(in srgb, var(--nd-dim) 45%, transparent);
		border-radius: 999px; padding: 1px 3px 1px 9px; cursor: grab; max-width: 100%;
	}
	.pill.measure {
		background: color-mix(in srgb, var(--nd-measure) 16%, transparent);
		border-color: color-mix(in srgb, var(--nd-measure) 45%, transparent);
	}
	.pill.small { font-size: 11px; }
	.pill-label {
		background: none; border: 0; padding: 2px 0; cursor: pointer; color: inherit;
		font: inherit; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.pill-x {
		background: none; border: 0; cursor: pointer; color: var(--nd-muted);
		font-size: 14px; line-height: 1; padding: 0 4px;
	}
	.pill-x:hover { color: var(--nd-accent); }

	.menu {
		position: absolute; top: calc(100% + 4px); left: 0; z-index: 40;
		background: var(--nd-bg); border: 1px solid var(--nd-border); border-radius: 6px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.14); padding: 4px; min-width: 190px;
		max-height: 320px; overflow-y: auto;
	}
	.menu-head {
		font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--nd-muted); padding: 6px 8px 2px;
	}
	.menu-note {
		margin: 0; padding: 2px 8px 6px; font-size: 11px; line-height: 1.45;
		color: var(--nd-muted); max-width: 22rem;
	}
	.menu-item, .menu-close {
		display: block; width: 100%; text-align: left; background: none; border: 0;
		padding: 5px 8px; border-radius: 4px; cursor: pointer; color: inherit; font: inherit; font-size: 12px;
	}
	.menu-item:hover, .menu-close:hover { background: color-mix(in srgb, var(--nd-dim) 14%, transparent); }
	.menu-item.active { background: color-mix(in srgb, var(--nd-dim) 22%, transparent); font-weight: 600; }
	.menu-close { margin-top: 4px; border-top: 1px solid var(--nd-border); border-radius: 0; color: var(--nd-muted); }

	.viz { position: relative; padding: 10px; }
	.chart { width: 100%; }
	.state {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 4px; height: 100%; min-height: 300px; color: var(--nd-muted); text-align: center;
	}
	.state strong { color: var(--nd-text); }
	.state p { margin: 0; max-width: 34ch; font-size: 12px; }
	.state.error strong { color: #d03b3b; }
	.loading {
		position: absolute; top: 12px; right: 14px; font-size: 11px; color: var(--nd-muted);
		background: var(--nd-bg); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--nd-border);
	}

	.table-wrap { overflow: auto; max-height: 480px; }
	table { width: 100%; border-collapse: collapse; font-size: 12px; }
	th, td { padding: 4px 10px; border-bottom: 1px solid var(--nd-border); text-align: left; white-space: nowrap; }
	th { position: sticky; top: 0; background: var(--nd-bg); font-weight: 600; color: var(--nd-muted); }
	th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }

	.bigvalues { display: flex; gap: 32px; padding: 24px 8px; flex-wrap: wrap; }
	.bv-title { display: block; font-size: 12px; color: var(--nd-muted); }
	.bv-value { display: block; font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; }

	.warning {
		margin: 0 10px 6px; padding: 6px 10px; font-size: 11px; border-radius: 5px;
		background: color-mix(in srgb, #fab219 18%, transparent);
		border: 1px solid color-mix(in srgb, #fab219 40%, transparent);
	}

	.foot {
		display: flex; align-items: center; gap: 8px; padding: 8px 10px;
		border-top: 1px solid var(--nd-border);
	}
	.spacer { flex: 1; }
	.ghost, .primary {
		font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--nd-border); background: var(--nd-bg); color: var(--nd-text);
	}
	.primary { background: var(--nd-dim); border-color: var(--nd-dim); color: #fff; }
	.ghost:disabled, .primary:disabled { opacity: 0.45; cursor: not-allowed; }

	.sql {
		margin: 0 10px 10px; padding: 10px; font-size: 11px; line-height: 1.5;
		background: var(--nd-panel); border: 1px solid var(--nd-border); border-radius: 6px;
		overflow: auto; max-height: 300px; white-space: pre;
	}

	.card { padding: 10px; border-bottom: 1px solid var(--nd-border); }
	.card-title {
		font-weight: 600; font-size: 11px; text-transform: uppercase;
		letter-spacing: 0.06em; color: var(--nd-muted); margin-bottom: 8px;
	}
	.marks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
	.mark {
		font: inherit; font-size: 11px; padding: 5px 6px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--nd-border); background: var(--nd-bg); color: var(--nd-text);
	}
	.mark:disabled { opacity: 0.35; cursor: not-allowed; }
	.mark.active { border-color: var(--nd-dim); background: color-mix(in srgb, var(--nd-dim) 16%, transparent); font-weight: 600; }
	.mark.chosen { outline: 1px solid var(--nd-dim); }
	.reason { margin: 8px 0 0; font-size: 11px; line-height: 1.45; color: var(--nd-muted); }

	.mark-shelf { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
	.toggle { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--nd-muted); margin-top: 6px; }

	.filter {
		display: flex; align-items: center; gap: 5px; font-size: 11px;
		padding: 4px 0; border-bottom: 1px solid var(--nd-border);
	}
	.filter-values { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }

	.muted { color: var(--nd-muted); }
	.small { font-size: 11px; }
	.pad { padding: 10px; margin: 0; }

	@container (max-width: 1040px) {
		.noodle { grid-template-columns: 1fr; }
		.data-panel, .side { border-left: 0; border-right: 0; border-bottom: 1px solid var(--nd-border); }
		.scroll { max-height: var(--nd-fields-stacked, 200px); }
		.marks { grid-template-columns: repeat(4, 1fr); }
	}

	/* No container-query support: fall back to the viewport. */
	@supports not (container-type: inline-size) {
		@media (max-width: 1100px) {
			.noodle { grid-template-columns: 1fr; }
			.data-panel, .side { border-left: 0; border-right: 0; border-bottom: 1px solid var(--nd-border); }
			.scroll { max-height: var(--nd-fields-stacked, 200px); }
		}
	}
</style>
