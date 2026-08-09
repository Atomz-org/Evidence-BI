<script>
	/**
	 * Studio — build a dashboard or a report without writing a page.
	 *
	 * noodle answers one question. This is the composition: several views sharing
	 * one filter context, arranged on a grid, saved, and published back to
	 * Evidence markdown. The interactions people expect from Power BI and Tableau
	 * are all here — slicers, cross-filtering by clicking a mark, drag-free tile
	 * layout, duplicate, present mode, print — but the exit is different, and the
	 * difference is the point: what you assemble by clicking leaves as source.
	 *
	 *   <Studio tables={['schema.orders']} relationships={[...]} />
	 *
	 * Two things are deliberately not free-form. Tiles flow into a twelve-column
	 * grid rather than sitting at absolute coordinates, because a flow reads on a
	 * laptop, a phone and a sheet of paper without being re-laid-out three times.
	 * And a dashboard is saved as specifications, never as results, so reopening
	 * it re-runs the queries instead of showing yesterday's numbers.
	 */
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	import Noodle from './Noodle.svelte';
	import Tile from './noodle/Tile.svelte';

	import { buildCatalog } from './noodle/engine/catalog.js';
	import { catalogFromCubeMeta, createCubeClient } from './noodle/engine/cube.js';
	import { detectMode } from './noodle/engine/theme.js';
	import { dropField, emptySpec } from './noodle/engine/spec.js';
	import { tableRef, ident } from './noodle/engine/sql.js';
	import {
		TILE_HEIGHTS,
		TILE_WIDTHS,
		addPageFilter,
		addTile,
		dashboardToMarkdown,
		describeFilter,
		deserializeDashboard,
		duplicateTile,
		emptyDashboard,
		layoutRows,
		makeTile,
		moveTile,
		removePageFilter,
		removeTile,
		serializeDashboard,
		tileContext,
		toggleCrossFilter,
		updateTile
	} from './noodle/engine/dashboard.js';

	/** Fully qualified tables to expose. */
	export let tables = [];
	/** Logical links between them. */
	export let relationships = [];
	/** Per-field overrides, keyed `schema.table.column`. */
	export let fields = {};
	/** Display names per table. */
	export let labels = {};
	/** Use Cube as the semantic layer: `{ apiUrl, token?, viewsOnly? }`. */
	export let cube = null;
	/** Where saved dashboards live in this browser. */
	export let storageKey = 'noodle.studio.v1';
	/** A dashboard to open with, in the serialized shape. */
	export let starter = null;
	/** Start in `edit` or `present`. */
	export let initialView = 'edit';

	let catalog = null;
	let cubeClient = null;
	let stats = {};
	let mode = 'light';
	let booting = true;
	let error = null;

	let dashboard = emptyDashboard();
	let view = initialView;

	let editingId = null;
	let editorSpec = null;

	let showPublish = false;
	let published = '';
	let copied = false;

	let savedNames = [];
	let openName = '';
	let saveNotice = '';

	let filterPicker = false;
	let filterField = null;
	let filterValues = [];
	let filterChosen = [];
	let filterLoading = false;

	/* ------------------------------------------------------------- startup -- */

	onMount(async () => {
		if (!browser) return;
		mode = detectMode();

		try {
			if (cube) {
				cubeClient = createCubeClient(cube);
				catalog = catalogFromCubeMeta(await cubeClient.meta(), { viewsOnly: cube.viewsOnly });
			} else {
				const { query } = await import('@evidence-dev/universal-sql/client-duckdb');
				catalog = await buildCatalog(query, { tables, relationships, fields, labels });
				await loadCardinality(query);
			}

			if (starter) dashboard = deserializeDashboard(starter);
			else if (catalog) dashboard = autoBuild(emptyDashboard({ title: 'New dashboard' }));
		} catch (e) {
			error = e?.message ?? String(e);
		}
		booting = false;

		refreshSaved();

		const observer = new MutationObserver(() => {
			const next = detectMode();
			if (next !== mode) mode = next;
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
		return () => observer.disconnect();
	});

	/** Cardinality decides bar-versus-table, so Show Me needs it before it ranks. */
	const loadCardinality = async (query) => {
		const dimensions = (catalog?.fields ?? []).filter((f) => f.role === 'dimension' && f.dataType !== 'date');
		const next = {};
		await Promise.all(
			dimensions.slice(0, 40).map(async (field) => {
				try {
					const [row] = await query(
						`select count(distinct ${ident(field.column)}) as n from ${tableRef(field.table)}`
					);
					next[field.id] = { distinct: Number(row?.n ?? 0) };
				} catch {
					/* a column we cannot count simply has no hint */
				}
			})
		);
		stats = next;
	};

	/* ------------------------------------------------------------ starters -- */

	const firstDate = () => catalog?.fields.find((f) => f.role === 'dimension' && f.dataType === 'date');

	/**
	 * The measure a headline should show.
	 *
	 * Catalog order is table order, and the first numeric column in a table is
	 * rarely the one anybody wants on a KPI tile — a line-item count sitting where
	 * revenue should be is a draft nobody trusts. A money format is the strongest
	 * available signal for "this is the number the table is about".
	 */
	const headlineMeasure = () =>
		catalog?.fields.find((f) => f.role === 'measure' && /usd|eur|gbp/.test(f.format ?? '')) ??
		catalog?.fields.find((f) => f.role === 'measure');

	/** How readable a categorical field is as an axis, lower being better. */
	const categoryRank = (n) => (n >= 3 && n <= 12 ? 0 : n >= 2 && n <= 40 ? 1 : 2);

	/**
	 * The most useful categorical field: enough values to compare, few enough to
	 * read. A key or an id has one bar per row and tells you nothing.
	 */
	const bestCategory = () => {
		const candidates = (catalog?.fields ?? []).filter(
			(f) => f.role === 'dimension' && f.dataType !== 'date'
		);
		const scored = candidates
			.map((f) => ({ f, n: stats[f.id]?.distinct ?? 0 }))
			.filter((c) => c.n >= 2)
			.sort((a, b) => categoryRank(a.n) - categoryRank(b.n) || a.n - b.n);
		return scored[0]?.f ?? candidates[0];
	};

	/** A starter view, and the title that describes it. */
	const draftFor = (kind) => {
		let spec = emptySpec(cube ? null : (tables[0] ?? null));
		const measure = headlineMeasure();
		const date = firstDate();
		const category = bestCategory();
		if (!measure) return null;

		if (kind === 'kpi') {
			spec = dropField(spec, catalog, measure, 'rows');
			return { spec: { ...spec, mark: 'bigvalue' }, title: `Total ${measure.name}`, w: 3, h: 180 };
		}
		if (kind === 'trend' && date) {
			spec = dropField(spec, catalog, date, 'columns');
			spec = dropField(spec, catalog, measure, 'rows');
			return { spec: { ...spec, mark: 'line' }, title: `${measure.name} over time`, w: 9, h: 180 };
		}
		if (kind === 'breakdown' && category) {
			spec = dropField(spec, catalog, category, 'columns');
			spec = dropField(spec, catalog, measure, 'rows');
			return { spec: { ...spec, mark: 'auto' }, title: `${measure.name} by ${category.name}`, w: 6, h: 260 };
		}
		if (kind === 'table' && category) {
			spec = dropField(spec, catalog, category, 'columns');
			spec = dropField(spec, catalog, measure, 'rows');
			return { spec: { ...spec, mark: 'table' }, title: 'Detail', w: 6, h: 260 };
		}
		return null;
	};

	/**
	 * A first draft in one click.
	 *
	 * Not a substitute for building the thing you meant — it is the fastest way to
	 * see whether the data supports the question at all, which is what a blank
	 * canvas is bad at.
	 */
	const autoBuild = (base) => {
		let next = base;
		for (const kind of ['kpi', 'trend', 'breakdown', 'table']) {
			const draft = draftFor(kind);
			if (draft) next = addTile(next, makeTile(draft));
		}
		return next;
	};

	/* ---------------------------------------------------------------- tiles -- */

	// Merged specs are memoised on content, not rebuilt per render. Without this,
	// any change anywhere on the page hands every tile a new spec object and every
	// tile re-runs its query — editing one view would re-query the whole page.
	const specCache = new Map();
	const stableSpec = (tile, context) => {
		const filterKey = JSON.stringify(context.applied);
		const hit = specCache.get(tile.id);
		if (hit && hit.source === tile.spec && hit.filterKey === filterKey) return hit.merged;
		specCache.set(tile.id, { source: tile.spec, filterKey, merged: context.spec });
		return context.spec;
	};

	$: contexts = Object.fromEntries(
		(dashboard.tiles ?? []).map((tile) => [tile.id, tileContext(dashboard, tile, catalog)])
	);
	$: report = dashboard.mode === 'report';
	// A report is read in sequence and cites exhibits, so it is one view per row
	// on screen as well as on the published page — the two should not disagree
	// about what the document looks like.
	$: gridRows = layoutRows(dashboard.tiles ?? [], report ? 1 : 12);
	$: editable = view === 'edit';

	const newTile = (kind = null) => {
		const draft = kind ? draftFor(kind) : null;
		const tile = draft
			? makeTile(draft)
			: makeTile({ spec: emptySpec(cube ? null : (tables[0] ?? null)), title: '', w: 6, h: 260 });
		dashboard = addTile(dashboard, tile);
		if (!kind) edit(tile.id);
	};

	const edit = (tileId) => {
		const tile = dashboard.tiles.find((t) => t.id === tileId);
		if (!tile) return;
		editingId = tileId;
		editorSpec = tile.spec ?? emptySpec(cube ? null : (tables[0] ?? null));
	};

	const closeEditor = () => {
		editingId = null;
		editorSpec = null;
	};

	// Live: the grid behind the drawer updates as the view is built, so the tile is
	// judged in its context rather than in isolation.
	$: if (editingId && editorSpec) dashboard = updateTile(dashboard, editingId, { spec: editorSpec });

	/* -------------------------------------------------------------- filters -- */

	const onSelect = (tileId, detail) => {
		dashboard = toggleCrossFilter(dashboard, { tileId, ...detail });
	};

	const clearCrossFilter = () => {
		dashboard = { ...dashboard, crossFilter: null };
	};

	const openFilterPicker = () => {
		filterPicker = true;
		filterField = null;
		filterValues = [];
		filterChosen = [];
	};

	/**
	 * Load a dimension's values for the slicer.
	 *
	 * Capped, and the cap is shown. A picker that silently lists the first two
	 * hundred of nine thousand values invites someone to conclude the rest do not
	 * exist.
	 */
	const chooseFilterField = async (field) => {
		filterField = field;
		filterChosen = [];
		filterValues = [];
		filterLoading = true;
		try {
			if (cube) {
				const response = await cubeClient.load({ dimensions: [field.id], limit: 200 });
				filterValues = (response?.data ?? []).map((r) => r[field.id]).filter((v) => v !== null);
			} else {
				const { query } = await import('@evidence-dev/universal-sql/client-duckdb');
				const rows = await query(
					`select distinct ${ident(field.column)} as v from ${tableRef(field.table)}` +
						` where ${ident(field.column)} is not null order by 1 limit 200`
				);
				filterValues = rows.map((r) => r.v);
			}
		} catch (e) {
			error = e?.message ?? String(e);
		} finally {
			filterLoading = false;
		}
	};

	const applyFilter = () => {
		if (!filterField || !filterChosen.length) return;
		dashboard = addPageFilter(dashboard, {
			fieldId: filterField.id,
			role: 'dimension',
			op: 'in',
			values: filterChosen
		});
		filterPicker = false;
	};

	const toggleValue = (value) => {
		filterChosen = filterChosen.includes(value)
			? filterChosen.filter((v) => v !== value)
			: [...filterChosen, value];
	};

	/* ---------------------------------------------------------- persistence -- */

	const readStore = () => {
		try {
			return JSON.parse(localStorage.getItem(storageKey) ?? '{}');
		} catch {
			return {};
		}
	};

	const refreshSaved = () => {
		if (!browser) return;
		savedNames = Object.keys(readStore()).sort();
	};

	const save = () => {
		const store = readStore();
		store[dashboard.title || 'Untitled'] = serializeDashboard(dashboard);
		localStorage.setItem(storageKey, JSON.stringify(store));
		refreshSaved();
		saveNotice = `Saved “${dashboard.title}”`;
		setTimeout(() => (saveNotice = ''), 2200);
	};

	const open = (name) => {
		if (!name) return;
		try {
			dashboard = deserializeDashboard(readStore()[name]);
			specCache.clear();
			closeEditor();
			error = null;
		} catch (e) {
			error = e?.message ?? String(e);
		}
	};

	const removeSaved = (name) => {
		const store = readStore();
		delete store[name];
		localStorage.setItem(storageKey, JSON.stringify(store));
		refreshSaved();
	};

	const download = (filename, text, type = 'text/plain') => {
		const url = URL.createObjectURL(new Blob([text], { type }));
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(url);
	};

	const slug = () =>
		(dashboard.title || 'dashboard').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
		'dashboard';

	const exportJson = () => download(`${slug()}.json`, serializeDashboard(dashboard), 'application/json');

	const importJson = async (event) => {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			dashboard = deserializeDashboard(await file.text());
			specCache.clear();
			closeEditor();
			error = null;
		} catch (e) {
			error = e?.message ?? String(e);
		}
		event.target.value = '';
	};

	/* ------------------------------------------------------------- publish -- */

	const publish = () => {
		published = dashboardToMarkdown({
			catalog,
			dashboard,
			generatedOn: new Date().toISOString().slice(0, 10)
		});
		showPublish = true;
		copied = false;
	};

	const copyPublished = async () => {
		try {
			await navigator.clipboard.writeText(published);
			copied = true;
			setTimeout(() => (copied = false), 1800);
		} catch {
			/* the textarea is right there */
		}
	};

	/**
	 * Fields offered as a slicer, most useful first.
	 *
	 * Catalog order is table order, which puts the primary key at the top — and a
	 * slicer offering five hundred order ids is worse than no slicer at all.
	 * Fewest distinct values first; anything uncounted sinks to the bottom.
	 */
	$: dimensionGroups = (catalog?.tables ?? []).map((table) => ({
		table,
		items: (catalog?.fields ?? [])
			.filter((f) => f.table === table.name && f.role === 'dimension')
			.sort((a, b) => (stats[a.id]?.distinct ?? Infinity) - (stats[b.id]?.distinct ?? Infinity))
	}));
</script>

<div class="studio-outer">
<div class="studio" class:dark={mode === 'dark'} class:report>
	<!-- ------------------------------------------------------------ header -- -->
	<header class="bar">
		{#if editable}
			<input class="title-input" bind:value={dashboard.title} aria-label="Dashboard title" />
		{:else}
			<h2 class="title">{dashboard.title}</h2>
		{/if}

		<div class="seg" role="group" aria-label="Kind">
			{#each [['dashboard', 'Dashboard'], ['report', 'Report']] as [value, text]}
				<button
					class="seg-btn"
					class:on={dashboard.mode === value}
					on:click={() => (dashboard = { ...dashboard, mode: value })}
				>{text}</button>
			{/each}
		</div>

		<span class="spacer"></span>

		{#if saveNotice}<span class="notice">{saveNotice}</span>{/if}

		<div class="seg" role="group" aria-label="View">
			{#each [['edit', 'Edit'], ['present', 'Present']] as [value, text]}
				<button class="seg-btn" class:on={view === value} on:click={() => (view = value)}>{text}</button>
			{/each}
		</div>

		{#if editable}
			<button class="ghost" on:click={() => newTile()}>+ View</button>
			<button class="ghost" on:click={() => (dashboard = autoBuild({ ...dashboard, tiles: [] }))}>
				Auto-build
			</button>
		{/if}
		<button class="ghost" on:click={save}>Save</button>
		<select class="ghost select" bind:value={openName} on:change={() => open(openName)} aria-label="Open saved">
			<option value="">Open…</option>
			{#each savedNames as name}<option value={name}>{name}</option>{/each}
		</select>
		<button class="ghost" on:click={exportJson}>Export</button>
		<label class="ghost file">
			Import
			<input type="file" accept="application/json" on:change={importJson} />
		</label>
		<button class="ghost" on:click={() => window.print()}>Print</button>
		<button class="primary" on:click={publish} disabled={!catalog}>Publish as code</button>
	</header>

	{#if editable}
		<input class="subtitle-input" bind:value={dashboard.subtitle} placeholder="Subtitle — say what this page is, and what it excludes" />
	{:else if dashboard.subtitle}
		<p class="subtitle">{dashboard.subtitle}</p>
	{/if}

	<!-- ------------------------------------------------------- filter bar -- -->
	<div class="filters">
		<span class="filters-label">Filters</span>

		{#each dashboard.filters ?? [] as filter, i}
			<span class="chip">
				{describeFilter(catalog, filter)}
				<button class="chip-x" on:click={() => (dashboard = removePageFilter(dashboard, i))} aria-label="Remove filter">×</button>
			</span>
		{/each}

		{#if dashboard.crossFilter}
			<span class="chip cross">
				{dashboard.crossFilter.label ?? describeFilter(catalog, { ...dashboard.crossFilter, op: 'in' })}
				<button class="chip-x" on:click={clearCrossFilter} aria-label="Clear cross-filter">×</button>
			</span>
		{/if}

		{#if !(dashboard.filters ?? []).length && !dashboard.crossFilter}
			<span class="muted small">None. Click any mark on a view to filter the rest of the page.</span>
		{/if}

		<span class="spacer"></span>
		<button class="ghost small" on:click={openFilterPicker} disabled={!catalog}>+ Filter</button>
	</div>

	{#if error}
		<p class="error-bar">{error}</p>
	{/if}

	<!-- ------------------------------------------------------------- grid -- -->
	{#if booting}
		<p class="muted pad">Building the catalog…</p>
	{:else if !dashboard.tiles.length}
		<div class="blank">
			<strong>An empty canvas</strong>
			<p>Add a view, or let the data suggest one.</p>
			<div class="starters">
				{#each [['kpi', 'A number'], ['trend', 'A trend'], ['breakdown', 'A breakdown'], ['table', 'A table']] as [kind, text]}
					<button class="ghost" on:click={() => newTile(kind)}>{text}</button>
				{/each}
				<button class="primary" on:click={() => (dashboard = autoBuild(dashboard))}>Auto-build</button>
			</div>
		</div>
	{:else}
		<div class="grid" class:presenting={!editable}>
			{#each gridRows as row, rowIndex (rowIndex)}
				<div class="row">
					{#each row as tile (tile.id)}
						<section class="tile" style="flex: {tile.w} 1 0; min-width: {report ? '100%' : '220px'}">
							<div class="tile-head">
								{#if editable}
									<input
										class="tile-title"
										value={tile.title}
										placeholder="Untitled view"
										on:input={(e) => (dashboard = updateTile(dashboard, tile.id, { title: e.target.value }))}
										aria-label="View title"
									/>
								{:else}
									<span class="tile-title-text">{tile.title || 'Untitled view'}</span>
								{/if}

								{#if dashboard.crossFilter?.tileId === tile.id}
									<span class="badge" title="This view is the source of the page's cross-filter">filtering</span>
								{/if}

								{#if editable}
									<span class="tile-tools">
										<select
											class="mini"
											value={tile.w}
											on:change={(e) => (dashboard = updateTile(dashboard, tile.id, { w: Number(e.target.value) }))}
											aria-label="Width"
										>
											{#each TILE_WIDTHS as w}<option value={w}>{w}/12</option>{/each}
										</select>
										<select
											class="mini"
											value={tile.h}
											on:change={(e) => (dashboard = updateTile(dashboard, tile.id, { h: Number(e.target.value) }))}
											aria-label="Height"
										>
											{#each TILE_HEIGHTS as h}<option value={h}>{h}px</option>{/each}
										</select>
										<button class="icon" title="Move earlier" on:click={() => (dashboard = moveTile(dashboard, tile.id, -1))}>←</button>
										<button class="icon" title="Move later" on:click={() => (dashboard = moveTile(dashboard, tile.id, 1))}>→</button>
										<button class="icon" title="Edit" on:click={() => edit(tile.id)}>Edit</button>
										<button class="icon" title="Duplicate" on:click={() => (dashboard = duplicateTile(dashboard, tile.id))}>⧉</button>
										<button class="icon danger" title="Delete" on:click={() => (dashboard = removeTile(dashboard, tile.id))}>×</button>
									</span>
								{/if}
							</div>

							<Tile
								{catalog}
								{cube}
								{cubeClient}
								{stats}
								spec={stableSpec(tile, contexts[tile.id])}
								height={tile.h}
								ignored={contexts[tile.id]?.ignored ?? []}
								highlight={dashboard.crossFilter?.tileId === tile.id ? dashboard.crossFilter : null}
								on:select={(e) => onSelect(tile.id, e.detail)}
							/>
						</section>
					{/each}
				</div>
			{/each}
		</div>
	{/if}

	<footer class="foot">
		<span class="muted small">
			{dashboard.tiles.length} view{dashboard.tiles.length === 1 ? '' : 's'} ·
			{report ? 'report layout, one exhibit per row' : 'twelve-column grid'} ·
			saved in this browser only
		</span>
		<span class="spacer"></span>
		{#each savedNames.slice(0, 4) as name}
			<button class="link" on:click={() => open(name)}>{name}</button>
			<button class="link danger" on:click={() => removeSaved(name)} aria-label="Delete {name}">×</button>
		{/each}
	</footer>
</div>
</div>

<!-- ------------------------------------------------------------- editor -- -->
{#if editingId}
	<div class="drawer">
		<div class="drawer-head">
			<strong>Editing “{dashboard.tiles.find((t) => t.id === editingId)?.title || 'Untitled view'}”</strong>
			<span class="muted small">Changes appear on the dashboard as you make them.</span>
			<span class="spacer"></span>
			<button class="primary" on:click={closeEditor}>Done</button>
		</div>
		<!-- The worksheet *is* the tile editor. A dashboard that reimplemented
		     shelf editing would be a second place for the two to disagree about
		     what a spec means. -->
		<Noodle bind:spec={editorSpec} {catalog} {stats} {cube} {tables} height={320} />
	</div>
{/if}

<!-- ------------------------------------------------------------ publish -- -->
{#if showPublish}
	<div class="drawer">
		<div class="drawer-head">
			<strong>Publish as code</strong>
			<span class="muted small">
				Save this into <code>pages/</code> and it becomes a reviewed, versioned page like every other.
			</span>
			<span class="spacer"></span>
			<button class="ghost" on:click={copyPublished}>{copied ? 'Copied' : 'Copy'}</button>
			<button class="ghost" on:click={() => download(`${slug()}.md`, published, 'text/markdown')}>Download</button>
			<button class="primary" on:click={() => (showPublish = false)}>Close</button>
		</div>
		<pre class="code">{published}</pre>
	</div>
{/if}

<!-- ------------------------------------------------------- filter picker -- -->
{#if filterPicker}
	<div class="drawer short">
		<div class="drawer-head">
			<strong>Add a page filter</strong>
			<span class="spacer"></span>
			<button class="ghost" on:click={() => (filterPicker = false)}>Cancel</button>
			<button class="primary" on:click={applyFilter} disabled={!filterChosen.length}>
				Apply{filterChosen.length ? ` (${filterChosen.length})` : ''}
			</button>
		</div>
		<div class="picker">
			<div class="picker-col">
				<div class="card-title">Field</div>
				<div class="picker-scroll">
					{#each dimensionGroups as group}
						{#if group.items.length}
							<div class="role-label">{group.table.label}</div>
							{#each group.items as field}
								<button
									class="picker-item"
									class:on={filterField?.id === field.id}
									on:click={() => chooseFilterField(field)}
								>{field.name}</button>
							{/each}
						{/if}
					{/each}
				</div>
			</div>
			<div class="picker-col wide">
				<div class="card-title">Values</div>
				{#if filterLoading}
					<p class="muted small pad">Loading…</p>
				{:else if !filterField}
					<p class="muted small pad">Pick a field.</p>
				{:else}
					<div class="picker-scroll">
						{#each filterValues as value}
							<label class="picker-check">
								<input type="checkbox" checked={filterChosen.includes(value)} on:change={() => toggleValue(value)} />
								<span>{value}</span>
							</label>
						{/each}
					</div>
					{#if filterValues.length >= 200}
						<p class="muted small pad">First 200 values — narrow the field if what you want is not here.</p>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.studio-outer { container-type: inline-size; }

	.studio {
		--nd-bg: #ffffff;
		--nd-panel: #fafafa;
		--nd-border: #e4e4e7;
		--nd-text: #18181b;
		--nd-muted: #71717a;
		--nd-dim: #2a78d6;
		--nd-measure: #008300;
		--nd-accent: #eb6834;

		border: 1px solid var(--nd-border);
		border-radius: 8px;
		background: var(--nd-bg);
		color: var(--nd-text);
		font-size: 13px;
		margin: 1.5rem 0;
		width: 100%;
	}
	.studio.dark {
		--nd-bg: #09090b;
		--nd-panel: #111113;
		--nd-border: #27272a;
		--nd-text: #fafafa;
		--nd-muted: #a1a1aa;
		--nd-dim: #3987e5;
		--nd-measure: #199e70;
	}
	/* A report is read at a fixed measure and printed; a dashboard fills the room
	   it is given. Same tiles, different container. */
	.studio.report { max-width: 900px; margin-inline: auto; }

	.bar {
		display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
		padding: 8px 10px; border-bottom: 1px solid var(--nd-border); background: var(--nd-panel);
		border-radius: 8px 8px 0 0;
	}
	.title, .title-input { font-size: 15px; font-weight: 600; margin: 0; }
	.title-input {
		border: 1px solid transparent; background: none; color: inherit; font-family: inherit;
		padding: 3px 6px; border-radius: 5px; min-width: 200px;
	}
	.title-input:hover, .title-input:focus { border-color: var(--nd-border); background: var(--nd-bg); }

	.subtitle-input, .subtitle {
		display: block; width: 100%; box-sizing: border-box; margin: 0;
		padding: 6px 12px; font-size: 12px; color: var(--nd-muted);
		border: 0; border-bottom: 1px solid var(--nd-border); background: none; font-family: inherit;
	}

	.spacer { flex: 1; }
	.notice { font-size: 11px; color: var(--nd-measure); }

	.seg { display: inline-flex; border: 1px solid var(--nd-border); border-radius: 5px; overflow: hidden; }
	.seg-btn {
		font: inherit; font-size: 11px; padding: 4px 9px; border: 0; cursor: pointer;
		background: var(--nd-bg); color: var(--nd-muted);
	}
	.seg-btn.on { background: var(--nd-dim); color: #fff; font-weight: 600; }

	.ghost, .primary, .select {
		font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--nd-border); background: var(--nd-bg); color: var(--nd-text);
	}
	.primary { background: var(--nd-dim); border-color: var(--nd-dim); color: #fff; }
	.ghost:disabled, .primary:disabled { opacity: 0.45; cursor: not-allowed; }
	.ghost.small { font-size: 11px; padding: 3px 8px; }
	.file { position: relative; overflow: hidden; display: inline-block; }
	.file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

	.filters {
		display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
		padding: 7px 10px; border-bottom: 1px solid var(--nd-border);
	}
	.filters-label {
		font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nd-muted);
	}
	.chip {
		display: inline-flex; align-items: center; gap: 2px; font-size: 11px;
		background: color-mix(in srgb, var(--nd-dim) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--nd-dim) 40%, transparent);
		border-radius: 999px; padding: 2px 3px 2px 9px;
	}
	.chip.cross {
		background: color-mix(in srgb, var(--nd-accent) 14%, transparent);
		border-color: color-mix(in srgb, var(--nd-accent) 45%, transparent);
	}
	.chip-x {
		background: none; border: 0; cursor: pointer; color: var(--nd-muted);
		font-size: 13px; line-height: 1; padding: 0 4px;
	}

	.error-bar {
		margin: 0; padding: 6px 12px; font-size: 11px; color: #b3261e;
		background: color-mix(in srgb, #b3261e 10%, transparent);
		border-bottom: 1px solid var(--nd-border);
	}

	.grid { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
	.row { display: flex; gap: 8px; flex-wrap: wrap; }

	.tile {
		display: flex; flex-direction: column; min-width: 220px;
		border: 1px solid var(--nd-border); border-radius: 7px; background: var(--nd-bg);
		overflow: hidden;
	}
	/* The tools are a fixed width; the title is not. On a 3/12 tile that squeezes
	   the title to nothing, so the row wraps and the tools drop below instead. */
	.tile-head {
		display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
		padding: 5px 8px; border-bottom: 1px solid var(--nd-border); background: var(--nd-panel);
	}
	.tile-title, .tile-title-text { font-size: 12px; font-weight: 600; flex: 1; min-width: 110px; }
	.tile-title {
		border: 1px solid transparent; background: none; color: inherit;
		font-family: inherit; padding: 2px 4px; border-radius: 4px;
	}
	.tile-title:hover, .tile-title:focus { border-color: var(--nd-border); background: var(--nd-bg); }
	.tile-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.badge {
		font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 6px;
		border-radius: 999px; color: #fff; background: var(--nd-accent);
	}

	.tile-tools { display: flex; align-items: center; gap: 2px; }
	.icon, .mini {
		font: inherit; font-size: 10px; padding: 2px 5px; border-radius: 4px; cursor: pointer;
		border: 1px solid transparent; background: none; color: var(--nd-muted);
	}
	.mini { border-color: var(--nd-border); }
	.icon:hover { background: color-mix(in srgb, var(--nd-dim) 14%, transparent); color: var(--nd-text); }
	.icon.danger:hover { background: color-mix(in srgb, #b3261e 16%, transparent); color: #b3261e; }

	.blank {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 8px; padding: 56px 16px; color: var(--nd-muted); text-align: center;
	}
	.blank strong { color: var(--nd-text); }
	.blank p { margin: 0; font-size: 12px; }
	.starters { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }

	.foot {
		display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
		padding: 7px 10px; border-top: 1px solid var(--nd-border);
	}
	.link {
		font: inherit; font-size: 11px; background: none; border: 0; cursor: pointer;
		color: var(--nd-dim); padding: 1px 3px;
	}
	.link.danger { color: var(--nd-muted); }

	.drawer {
		position: fixed; inset: 6vh 4vw 6vh; z-index: 60;
		background: #fff; border: 1px solid #e4e4e7; border-radius: 10px;
		box-shadow: 0 24px 60px rgb(0 0 0 / 0.28);
		display: flex; flex-direction: column; overflow: auto;
	}
	.drawer.short { inset: 14vh 12vw; }
	.drawer-head {
		display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
		padding: 10px 14px; border-bottom: 1px solid #e4e4e7; position: sticky; top: 0;
		background: #fff; z-index: 2;
	}
	.code {
		margin: 0; padding: 14px; font-size: 11px; line-height: 1.55; white-space: pre;
		overflow: auto; flex: 1;
	}

	.picker { display: grid; grid-template-columns: 220px 1fr; gap: 0; flex: 1; min-height: 0; }
	.picker-col { border-right: 1px solid #e4e4e7; display: flex; flex-direction: column; min-height: 0; }
	.picker-col.wide { border-right: 0; }
	.picker-scroll { overflow-y: auto; padding: 4px; flex: 1; }
	.picker-item {
		display: block; width: 100%; text-align: left; font: inherit; font-size: 12px;
		padding: 4px 8px; border: 0; border-radius: 4px; background: none; cursor: pointer;
	}
	.picker-item:hover { background: #f1f5fb; }
	.picker-item.on { background: #e3edfb; font-weight: 600; }
	.picker-check { display: flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 12px; }
	.card-title {
		font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
		color: #71717a; padding: 8px 10px 4px;
	}
	.role-label {
		font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
		color: #71717a; padding: 6px 8px 2px;
	}

	.muted { color: var(--nd-muted); }
	.small { font-size: 11px; }
	.pad { padding: 10px; margin: 0; }

	@container (max-width: 780px) {
		.tile { min-width: 100% !important; }
	}

	/* Print: the chrome goes, the views stay, and nothing is cut in half. */
	@media print {
		.bar, .filters, .foot, .tile-tools, .drawer { display: none !important; }
		.studio { border: 0; margin: 0; }
		.tile { break-inside: avoid; border-color: #ccc; }
		.row { break-inside: avoid; }
	}
</style>
