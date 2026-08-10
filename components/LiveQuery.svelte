<!--
  LiveQuery — the SQL behind an exhibit, opened up and made editable.

  A published page is a claim, and the honest form of a claim is one the reader
  can check. Every exhibit here already names the compiled query behind it in its
  source line; this component goes one step further and lets the reader *run* it —
  read the SQL, change it, and watch the exhibit redraw from the result.

  It wraps the exhibit rather than replacing it:

      <LiveQuery query={trend} title="Exhibit 2.1" let:data>
          <LineChart data={data} x=period y=revenue yFmt=usdacck/>
      </LiveQuery>

  The child is the same Evidence component the page always used, with the same
  formats and the same colours, so making an exhibit live costs none of its
  design. Until someone presses Edit, `data` is the page's own query result and
  nothing about the page has changed.

  What it does not do is make the numbers governed. An edited query is the
  reader's, not the report's: the panel says so, the export is unaffected, and a
  reload restores the published SQL. The metric contract lives in dbt and in
  `queries/metrics/`, and no amount of editing here moves it.
-->
<script>
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	/**
	 * The page query this exhibit is built on. Its `.text` is the SQL as executed
	 * — refs like `${metrics_revenue}` already resolved — which is what makes the
	 * editor's starting point runnable rather than a template.
	 */
	export let query = null;

	/** A raw SQL string, when there is no page query to point at. */
	export let sql = null;

	/** Shown on the toolbar so a reader knows which exhibit they are opening. */
	export let title = '';

	/** Start with the editor open. */
	export let open = false;

	/** Rows to show when this renders its own table (no slot content given). */
	export let rowsShown = 12;

	let editorOpen = open;
	let editorText = '';
	/** Set once the reader types: the editor stops tracking the published SQL. */
	let touched = false;
	let published = '';
	let liveRows = null;
	let error = null;
	let running = false;
	let ranAt = null;
	let elapsed = null;
	let runner = null;
	let format = (v) => String(v ?? '');

	/** Evidence query results are array-like proxies; components want an array. */
	const toRows = (d) => (Array.isArray(d) ? d : d ? Array.from(d) : []);

	// The page's own rows, and the SQL that produced them.
	//
	// `query.text` fills in as the page's inputs resolve — a report whose grain
	// comes from a ButtonGroup reads `date_trunc('', …)` until that button group
	// has a value — and Evidence updates the query object in place rather than
	// handing over a new one, so a plain `$: published = query.text` would latch
	// onto the first, unresolved snapshot and show SQL that never ran. Reading it
	// alongside the rows ties it to the one signal that says something changed.
	$: pageRows = toRows(query ?? []);
	$: published = ((pageRows), (query?.text ?? sql ?? '')).trim();

	// The editor tracks the published SQL until the reader takes it over; after
	// that it is theirs, and only Reset hands it back.
	$: if (!touched && published) editorText = published;

	// Until the reader runs something, the exhibit shows the page's own data. This
	// is the whole safety property: opening the panel changes nothing.
	$: data = liveRows ?? pageRows;
	let ranByReader = false;
	$: edited = liveRows !== null && ranByReader;
	$: dirty = editorText.trim() !== published;

	onMount(async () => {
		if (!browser) return;
		const [duck, formatting] = await Promise.all([
			import('@evidence-dev/universal-sql/client-duckdb'),
			import('@evidence-dev/component-utilities/formatting')
		]);
		runner = duck.query;
		format = (value, code) => {
			if (value === null || value === undefined) return '—';
			try {
				return code ? formatting.fmt(value, code) : formatting.fmt(value, 'num0');
			} catch {
				return String(value);
			}
		};
	});

	/**
	 * Only reads run. DuckDB-wasm holds a private copy of the data, so a `create`
	 * or `drop` would harm nobody but the reader — and it would do it silently,
	 * for the rest of the session, to every other exhibit on the page. A reader
	 * exploring a report should not be able to leave it in a state they cannot
	 * explain, so the panel declines rather than letting them find out.
	 */
	const readOnly = (text) => {
		const stripped = text
			.replace(/--[^\n]*/g, ' ')
			.replace(/\/\*[\s\S]*?\*\//g, ' ')
			.trim();
		if (!stripped) return 'Nothing to run.';
		if (!/^(with|select|from|table|values|describe|summarize|pivot|unpivot)\b/i.test(stripped)) {
			return 'Only read queries run here — start with SELECT or WITH.';
		}
		// A CTE cannot hide one of these, but a second statement can.
		if (/;\s*\S/.test(stripped)) return 'One statement at a time.';
		if (/\b(insert|update|delete|drop|create|alter|attach|copy|export|install|load|pragma|set)\b/i.test(stripped)) {
			return 'Only read queries run here — no INSERT, UPDATE, CREATE, DROP or COPY.';
		}
		return null;
	};

	/**
	 * @param {{auto?: boolean}} [options] `auto` marks the first run of a
	 *   detached panel, which is that panel's published state rather than
	 *   something the reader did — badging it "edited" would be a lie about
	 *   provenance on a tile the reader has not touched.
	 */
	const run = async (options = {}) => {
		if (!runner) return;
		const refusal = readOnly(editorText);
		if (refusal) {
			error = refusal;
			return;
		}

		running = true;
		error = null;
		ranByReader = !options.auto;
		const started = performance.now();
		try {
			const result = await runner(editorText);
			liveRows = toRows(result).map((row) => ({ ...row }));
			elapsed = Math.round(performance.now() - started);
			ranAt = new Date().toLocaleTimeString();
		} catch (e) {
			// DuckDB's messages carry the position of the problem; keep them whole.
			error = e?.message ?? String(e);
		} finally {
			running = false;
		}
	};

	/**
	 * A panel with no page query behind it starts empty.
	 *
	 * When `query` is set, the exhibit is already on the page and opening the
	 * editor must change nothing — that is the whole safety property. A panel
	 * given only `sql` has no such exhibit: it would sit there showing "0 rows"
	 * until someone pressed Run, which reads as broken rather than as waiting.
	 * So a detached panel runs its own SQL once, and only once — after that the
	 * reader owns it.
	 */
	let autoRan = false;
	$: if (runner && !query && published && !autoRan && !touched) {
		autoRan = true;
		run({ auto: true });
	}

	/** Back to the SQL the report publishes, and to the page's own numbers. */
	const reset = () => {
		editorText = published;
		touched = false;
		liveRows = null;
		// A detached panel's "published" state is its own first run, so restore
		// that rather than an empty table.
		if (!query) autoRan = false;
		ranByReader = false;
		error = null;
		elapsed = null;
		ranAt = null;
	};

	const onKeydown = (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			run();
		}
	};

	$: columns = data.length ? Object.keys(data[0]) : [];
</script>

<div class="live" class:edited>
	<div class="bar">
		<button class="toggle" on:click={() => (editorOpen = !editorOpen)} aria-expanded={editorOpen}>
			<span class="chevron" class:open={editorOpen}>›</span>
			{editorOpen ? 'Hide SQL' : 'Edit SQL'}
		</button>
		{#if title}<span class="what">{title}</span>{/if}
		<span class="spacer"></span>
		{#if edited}
			<span class="badge">edited — not the published figure</span>
		{/if}
		<span class="count">{data.length.toLocaleString()} rows</span>
	</div>

	{#if editorOpen}
		<div class="editor">
			<textarea
				bind:value={editorText}
				on:input={() => (touched = true)}
				on:keydown={onKeydown}
				spellcheck="false"
				rows={Math.min(24, Math.max(6, editorText.split('\n').length + 1))}
			></textarea>
			<div class="actions">
				<button class="primary" on:click={run} disabled={running || !runner}>
					{running ? 'Running…' : 'Run'}
				</button>
				<button on:click={reset} disabled={!edited && !dirty}>Reset</button>
				<span class="hint">⌘/Ctrl + Enter</span>
				<span class="spacer"></span>
				{#if elapsed !== null && !error}
					<span class="hint">{elapsed} ms · {ranAt}</span>
				{/if}
			</div>
			{#if error}
				<p class="error">{error}</p>
			{/if}
			{#if !runner}
				<p class="hint pad">Connecting to the in-browser database…</p>
			{/if}
		</div>
	{/if}

	<div class="output">
		{#if $$slots.default}
			<slot {data} {edited} />
		{:else}
			<!-- No exhibit given: show the result itself, so the panel is useful on its own. -->
			<div class="scroll">
				<table>
					<thead>
						<tr>{#each columns as c}<th>{c}</th>{/each}</tr>
					</thead>
					<tbody>
						{#each data.slice(0, rowsShown) as row}
							<tr>
								{#each columns as c}
									<td class:num={typeof row[c] === 'number'}>
										{typeof row[c] === 'number' ? format(row[c], 'num2') : (row[c] ?? '—')}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if data.length > rowsShown}
				<p class="hint pad">{(data.length - rowsShown).toLocaleString()} more rows</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.live {
		margin: 0 0 1.25rem 0;
		border-left: 2px solid transparent;
		transition: border-color 0.15s;
	}
	.live.edited {
		border-left-color: var(--warning, #fab219);
		padding-left: 0.6rem;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.72rem;
		color: var(--grey-500, #71717a);
		padding-bottom: 0.3rem;
	}
	.spacer { flex: 1; }

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: var(--primary, #256abf);
		cursor: pointer;
	}
	.toggle:hover { text-decoration: underline; }
	.chevron { display: inline-block; transition: transform 0.15s; }
	.chevron.open { transform: rotate(90deg); }

	.what { color: var(--grey-500, #71717a); }
	.count { font-variant-numeric: tabular-nums; }

	.badge {
		background: var(--warning, #fab219);
		color: #3f3f46;
		border-radius: 3px;
		padding: 0.05rem 0.35rem;
		font-size: 0.68rem;
	}

	.editor {
		border: 1px solid var(--grey-200, #e4e4e7);
		border-radius: 6px;
		margin-bottom: 0.6rem;
		overflow: hidden;
	}

	textarea {
		width: 100%;
		border: 0;
		padding: 0.6rem 0.7rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		line-height: 1.5;
		resize: vertical;
		display: block;
		background: var(--grey-100, #fafafa);
		color: var(--grey-900, #18181b);
	}
	textarea:focus { outline: 2px solid var(--primary, #256abf); outline-offset: -2px; }

	.actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.4rem 0.5rem;
		border-top: 1px solid var(--grey-200, #e4e4e7);
	}

	button {
		font-size: 0.72rem;
		padding: 0.2rem 0.6rem;
		border: 1px solid var(--grey-200, #e4e4e7);
		border-radius: 4px;
		background: #fff;
		color: var(--grey-900, #18181b);
		cursor: pointer;
	}
	button:hover:not(:disabled) { border-color: var(--grey-400, #a1a1aa); }
	button:disabled { opacity: 0.45; cursor: default; }
	button.primary {
		background: var(--primary, #256abf);
		border-color: var(--primary, #256abf);
		color: #fff;
	}

	.hint { font-size: 0.68rem; color: var(--grey-500, #71717a); }
	.pad { margin: 0.35rem 0 0 0; }

	.error {
		margin: 0;
		padding: 0.5rem 0.7rem;
		border-top: 1px solid var(--grey-200, #e4e4e7);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		color: var(--negative, #d03b3b);
		white-space: pre-wrap;
	}

	.scroll { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
	th, td {
		text-align: left;
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid var(--grey-100, #f4f4f5);
		white-space: nowrap;
	}
	th { color: var(--grey-500, #71717a); font-weight: 500; }
	td.num { text-align: right; font-variant-numeric: tabular-nums; }

	/* The panel is chrome, not content: a printed report shows the exhibit only. */
	@media print {
		.bar, .editor { display: none; }
		.live.edited { border-left: 0; padding-left: 0; }
	}
</style>
