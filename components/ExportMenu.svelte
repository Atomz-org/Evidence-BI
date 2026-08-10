<!--
  Export — the same three ways out of every tile on the site.

  Consistency is the whole point. A reader who learns how to get the pivot into
  a spreadsheet has learned how to get the heatmap, the leaderboard and the
  notebook cell out too, and nobody has to wonder whether this particular chart
  happens to support it.

  What each one does, and its honest limitation, is in `components/flint/export.js`.

  Usage:

    <ExportMenu rows={data} name="Revenue by region" />
    <ExportMenu rows={data} columns={[{ key: 'region', label: 'Region' }]} compact />
-->
<script>
	import { onDestroy } from 'svelte';
	import { toCsv, toTsv, toGoogleSheets, copyText, downloadText, slug } from './flint/export.js';
	import { detectMode } from './noodle/engine/theme.js';

	/** The rows to hand over — exactly what the tile is showing, after its filters. */
	export let rows = [];
	/** Ordered `[{ key, label }]`. Omitted, the union of the rows' own keys in first-seen order. */
	export let columns = undefined;
	/** Names the file and the sheet; the tile's title is usually right. */
	export let name = 'export';
	/** Icon-only, for a panel header that is already full. */
	export let compact = false;

	let open = false;
	let wrapper;
	let anchor = { top: 0, right: 0 };
	let status = '';
	let statusTimer = null;
	/* The popover is `position: fixed`, so it hangs outside every panel and can
	   inherit nothing. Evidence's dark mode is not always a class on <html> —
	   `detectMode` also reads the painted surface — so the CSS cannot decide this
	   on its own. */
	let mode = 'light';

	$: available = Array.isArray(rows) ? rows.length : rows ? Array.from(rows).length : 0;
	$: plain = Array.isArray(rows) ? rows : rows ? Array.from(rows) : [];

	/**
	 * The menu is positioned against the viewport, not the button.
	 *
	 * Every panel on the canvas clips its body — that is what stops a chart
	 * growing its own row — so a popover positioned inside one is a popover with
	 * its bottom half cut off. Fixed positioning is the only placement that
	 * survives an ancestor with `overflow: hidden`.
	 */
	const place = () => {
		const box = wrapper?.getBoundingClientRect();
		if (!box) return;
		anchor = { top: Math.round(box.bottom + 4), right: Math.round(window.innerWidth - box.right) };
	};

	const toggle = () => {
		open = !open;
		if (!open) return;
		mode = detectMode();
		place();
	};

	const say = (message) => {
		status = message;
		clearTimeout(statusTimer);
		statusTimer = setTimeout(() => (status = ''), 6000);
	};

	const onOutside = (event) => {
		if (open && wrapper && !wrapper.contains(event.target)) open = false;
	};

	const onKey = (event) => {
		if (event.key === 'Escape' && open) open = false;
	};

	const sheets = async () => {
		open = false;
		const { copied, opened } = await toGoogleSheets(plain, { columns });
		say(
			copied && opened
				? `${available.toLocaleString()} rows copied — paste into the new sheet`
				: copied
					? 'Copied. The new-sheet tab was blocked — allow popups, or paste into a sheet yourself'
					: 'Could not reach the clipboard on this connection'
		);
	};

	const copyTsv = async () => {
		open = false;
		say((await copyText(toTsv(plain, columns))) ? `${available.toLocaleString()} rows copied as TSV` : 'Could not reach the clipboard');
	};

	const csv = () => {
		open = false;
		downloadText(`${slug(name)}.csv`, toCsv(plain, columns));
		say(`${slug(name)}.csv`);
	};

	onDestroy(() => clearTimeout(statusTimer));
</script>

<svelte:window on:click={onOutside} on:keydown={onKey} on:resize={() => open && place()} on:scroll={() => open && place()} />

<span class="export" bind:this={wrapper}>
	<button
		class="trigger"
		class:compact
		type="button"
		aria-haspopup="menu"
		aria-expanded={open}
		disabled={!available}
		title={available ? `Export ${available.toLocaleString()} rows` : 'Nothing to export yet'}
		on:click={toggle}
	>
		{#if compact}<span aria-hidden="true">⇪</span><span class="sr">Export</span>{:else}Export{/if}
	</button>

	{#if open}
		<div class="menu" class:dark={mode === 'dark'} role="menu" style="top:{anchor.top}px; right:{anchor.right}px">
			<button role="menuitem" type="button" on:click={sheets}>
				<strong>Google Sheets</strong>
				<em>Copies the rows and opens a blank sheet — paste with ⌘V</em>
			</button>
			<button role="menuitem" type="button" on:click={copyTsv}>
				<strong>Copy as TSV</strong>
				<em>For a spreadsheet you already have open</em>
			</button>
			<button role="menuitem" type="button" on:click={csv}>
				<strong>Download CSV</strong>
				<em>{slug(name)}.csv · {available.toLocaleString()} rows</em>
			</button>
		</div>
	{/if}

	{#if status}<span class="status" role="status">{status}</span>{/if}
</span>

<style>
	.export {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	.trigger {
		font: inherit;
		font-size: 0.72rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--grey-500, #71717a);
		border-radius: 4px;
		padding: 0.15rem 0.45rem;
		cursor: pointer;
		white-space: nowrap;
	}
	.trigger.compact {
		padding: 0.1rem 0.3rem;
		font-size: 0.85rem;
		line-height: 1;
	}
	/* `inherit`, not `--grey-900`: Evidence's grey ramp is the same on both
	   surfaces, so hovering in dark mode would darken the icon into the panel. */
	.trigger:hover:not(:disabled) {
		border-color: var(--grey-300, #d4d4d8);
		color: inherit;
	}
	.trigger:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.menu {
		position: fixed;
		z-index: 60;
		min-width: 15rem;
		display: flex;
		flex-direction: column;
		background: var(--bg, #fff);
		border: 1px solid var(--grey-300, #d4d4d8);
		border-radius: 7px;
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.13);
		overflow: hidden;
	}

	.menu button {
		font: inherit;
		text-align: left;
		background: transparent;
		border: 0;
		border-bottom: 1px solid var(--grey-100, #f4f4f5);
		padding: 0.45rem 0.7rem;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		color: var(--grey-900, #18181b);
	}
	.menu button:last-child {
		border-bottom: 0;
	}
	.menu button:hover {
		background: var(--grey-100, #f4f4f5);
	}
	.menu strong {
		font-size: 0.8rem;
		font-weight: 600;
	}
	.menu em {
		font-style: normal;
		font-size: 0.7rem;
		color: var(--grey-500, #71717a);
	}

	.status {
		font-size: 0.68rem;
		color: var(--grey-500, #71717a);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 22ch;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.menu.dark {
		background: #17181b;
		border-color: #2c2e33;
	}
	.menu.dark button {
		color: #e7e7ea;
		border-bottom-color: #2c2e33;
	}
	.menu.dark button:hover {
		background: #202227;
	}
	.menu.dark em {
		color: #9a9aa2;
	}
</style>
