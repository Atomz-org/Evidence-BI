/**
 * Flint → this project's design language.
 *
 * Flint (`flint-chart`) decides *structure*: which mark, which scale, how much
 * room the labels need, when to facet, where the legend goes. It is very good at
 * that and we do not second-guess it.
 *
 * It does not decide *colour* here. Flint's `theme_spec` — the ten houses,
 * economist/swiss/nature and the rest — is realized by the Vega-Lite assembler
 * only; the ECharts assembler accepts the field and ignores it, so an option
 * that comes out of `assembleECharts` still wears ECharts' stock palette
 * (#5470c6, #91cc75, …). Those hues are not CVD-checked against this project's
 * surfaces and they are not the ones in `evidence.config.yaml`.
 *
 * So the bridge runs after assembly and re-inks the option from
 * `components/noodle/engine/theme.js` — the same eight-slot palette, in the same
 * order, that the Noodle engine and the Evidence theme already use. Slot order is
 * the CVD-safety mechanism, so series keep their index: series *n* is always
 * palette slot *n*.
 *
 * What the bridge touches, and nothing else:
 *   colour      option.color, series[].itemStyle/lineStyle/areaStyle, visualMap
 *   chrome      axis lines, ticks, labels, gridlines, legend, tooltip, graphic text
 *   type        one font family, inherited from the page's computed style
 *   numbers     Evidence `fmt` codes on axis labels, tooltips and data labels
 *
 * Layout, sizing, faceting and mark choice are left exactly as Flint computed them.
 */

import { CATEGORICAL, SEQUENTIAL, CHROME, STATUS, reliefRequired } from '../noodle/engine/theme.js';

/** Tooltips are HTML strings; series names come from the data. */
const escapeHtml = (value) =>
	String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Flint emits `xAxis`/`yAxis`/`grid` as an object normally and an array when faceting. */
const each = (value, fn) => {
	if (Array.isArray(value)) value.forEach(fn);
	else if (value) fn(value);
};

/** ECharts' stock categorical palette — what we are replacing, used to detect it. */
const ECHARTS_DEFAULTS = new Set([
	'#5470c6',
	'#91cc75',
	'#fac858',
	'#ee6666',
	'#73c0de',
	'#3ba272',
	'#fc8452',
	'#9a60b4',
	'#ea7ccc',
	'#d48265'
]);

/**
 * A series carries its colour in whichever of these ECharts happens to read for
 * its mark type; assigning all three is cheaper than branching on `series.type`.
 */
const inkSeries = (series, colour) => {
	if (series.itemStyle && ECHARTS_DEFAULTS.has(series.itemStyle.color)) series.itemStyle.color = colour;
	else if (series.itemStyle) series.itemStyle = { ...series.itemStyle, color: colour };
	else series.itemStyle = { color: colour };

	if (series.lineStyle) series.lineStyle = { ...series.lineStyle, color: colour };
	if (series.areaStyle) series.areaStyle = { ...series.areaStyle, color: colour };
};

/**
 * Series share a colour when they share a name — the same region drawn across
 * three facet panels is one series to the reader, so it gets one hue. Panels are
 * separate `series` entries in ECharts, which is why this is keyed by name and
 * not by index.
 */
const paletteAssignments = (series, palette) => {
	const byName = new Map();
	for (const s of series ?? []) {
		const key = s.name ?? `__unnamed_${byName.size}`;
		if (!byName.has(key)) byName.set(key, byName.size);
	}
	return { byName, colourFor: (name) => palette[(byName.get(name) ?? 0) % palette.length] };
};

/**
 * Apply the project's ink to a Flint-assembled ECharts option.
 *
 * @param {object} option              output of `assembleECharts` (mutated in place)
 * @param {object} args
 * @param {'light'|'dark'} args.mode   the surface the page is painted on
 * @param {string} [args.font]         font family read off the container
 * @param {(v:unknown, f?:string)=>string} [args.fmt]  Evidence's formatter
 * @param {Record<string,string>} [args.formats]  channel → Evidence fmt code, e.g. `{ y: 'usd0k' }`
 * @returns {object} the same option
 */
export const applyProjectTheme = (option, { mode = 'light', font, fmt, formats = {} } = {}) => {
	const chrome = CHROME[mode];
	const palette = CATEGORICAL[mode];
	const format = fmt ?? ((v) => String(v ?? ''));

	option.backgroundColor = 'transparent';
	option.textStyle = { ...(option.textStyle ?? {}), color: chrome.text, ...(font ? { fontFamily: font } : {}) };
	option.color = palette;

	const { colourFor } = paletteAssignments(option.series, palette);
	for (const s of option.series ?? []) {
		// A single-series pie/treemap/sunburst colours its *slices*, not itself:
		// leave those to `option.color` so each datum picks the next slot in order.
		if (['pie', 'treemap', 'sunburst', 'funnel', 'sankey', 'graph'].includes(s.type)) continue;
		inkSeries(s, colourFor(s.name));
	}

	// A continuous colour channel is one hue, light→dark, reversed on the dark
	// surface so near-zero recedes into the page instead of glowing on it.
	each(option.visualMap, (vm) => {
		vm.inRange = { ...(vm.inRange ?? {}), color: SEQUENTIAL[mode] };
		vm.textStyle = { ...(vm.textStyle ?? {}), color: chrome.muted };
	});

	const inkAxis = (axis, channel) => {
		axis.axisLine = { ...(axis.axisLine ?? {}), lineStyle: { color: chrome.axis } };
		axis.axisTick = { ...(axis.axisTick ?? {}), lineStyle: { color: chrome.axis } };
		axis.splitLine = { ...(axis.splitLine ?? {}), lineStyle: { color: chrome.grid } };
		axis.nameTextStyle = { ...(axis.nameTextStyle ?? {}), color: chrome.text };
		axis.axisLabel = { ...(axis.axisLabel ?? {}), color: chrome.muted };

		// Flint leaves numbers unformatted; this project never ships a raw float.
		// A string formatter (Flint's own date pattern) is left alone.
		const code = formats[channel];
		if (code && axis.type === 'value') axis.axisLabel.formatter = (v) => format(v, code);
	};
	each(option.xAxis, (a) => inkAxis(a, 'x'));
	each(option.yAxis, (a) => inkAxis(a, 'y'));

	// A legend that names some of the series is worse than no legend: the reader
	// takes it as the full key and mis-reads every colour it left out. Flint emits
	// exactly that when a chart is faceted by the same field it colours by — one
	// entry for three panels. Those panels carry their own titles, so the honest
	// repair is to drop the legend rather than complete it.
	const seriesNames = new Set((option.series ?? []).map((s) => s.name).filter(Boolean));
	if (option.legend && !Array.isArray(option.legend) && Array.isArray(option.legend.data)) {
		if (option.legend.data.length < seriesNames.size) {
			delete option.legend;
			// The "region" header Flint draws beside it goes with it.
			if (Array.isArray(option.graphic)) option.graphic = option.graphic.filter((g) => g.type !== 'text');
		}
	}

	if (option.legend) {
		each(option.legend, (l) => {
			l.textStyle = { ...(l.textStyle ?? {}), color: chrome.text };
			l.inactiveColor = chrome.muted;
		});
	}

	// Flint writes the legend header ("region") as a `graphic` text element with
	// a hardcoded #333 fill, which disappears on the dark surface.
	each(option.graphic, (g) => {
		if (g.type === 'text' && g.style) g.style.fill = chrome.text;
	});

	option.tooltip = {
		...(option.tooltip ?? {}),
		backgroundColor: chrome.tooltipBg,
		borderColor: chrome.tooltipBorder,
		textStyle: { color: chrome.text, fontSize: 12 },
		extraCssText: 'box-shadow: 0 2px 8px rgba(0,0,0,.12);'
	};

	// The measure's format belongs in the tooltip too, otherwise the axis reads
	// "$1.2M" and the hover reads "1203441.77" for the same bar.
	//
	// Flint writes its own tooltip formatter for every chart type, and because it
	// is a function ECharts ignores `valueFormatter` entirely — so the only way to
	// format the hover is to replace the formatter. That trades Flint's per-encoding
	// layout for a formatted number, which is the right trade here: an unformatted
	// figure is a defect in this project, an unlabelled secondary channel is not.
	const valueFormat = formats.y ?? formats.value ?? formats.size;
	if (valueFormat) {
		option.tooltip.formatter = (params) => {
			const points = Array.isArray(params) ? params : [params];
			const head = points[0]?.axisValueLabel ?? (points.length > 1 ? points[0]?.name : '');
			const body = points
				.map((p) => {
					// Heatmap and scatter carry [x, y, measure]; the measure is last.
					const raw = Array.isArray(p.value) ? p.value[p.value.length - 1] : (p.value?.value ?? p.value);
					const label = p.seriesName && p.seriesName !== p.name ? p.seriesName : p.name;
					return `<div>${p.marker ?? ''}${escapeHtml(label ?? '')} <strong>${escapeHtml(format(raw, valueFormat))}</strong></div>`;
				})
				.join('');
			return (head ? `<div style="margin-bottom:2px;opacity:.75">${escapeHtml(head)}</div>` : '') + body;
		};
		delete option.tooltip.valueFormatter;
	}

	// Data labels, wherever Flint turned them on.
	for (const s of option.series ?? []) {
		if (s.label?.show) {
			s.label = { ...s.label, color: chrome.text };
			if (valueFormat && !s.label.formatter) s.label.formatter = (p) => format(p.value?.[2] ?? p.value, valueFormat);
		}
	}

	return option;
};

/**
 * The rules this project treats as non-negotiable, checked against a *compiled*
 * option rather than against the spec — by then Flint has resolved how many
 * series there actually are, whether it faceted, and what the legend says.
 *
 * This is what the dashboard loop scores. Each finding names the rule so a fix
 * can be looked up rather than guessed at.
 *
 * @returns {{level:'error'|'warn', rule:string, message:string}[]}
 */
export const auditOption = (option, { mode = 'light', chartType = '', hasRelief = false } = {}) => {
	const findings = [];
	const seriesNames = new Set((option.series ?? []).map((s) => s.name).filter(Boolean));
	const count = seriesNames.size || (option.series ?? []).length;

	// "Fixed hue order, never cycled" — a ninth hue is never invented.
	if (count > CATEGORICAL[mode].length) {
		findings.push({
			level: 'error',
			rule: 'palette-exhausted',
			message: `${count} series but only ${CATEGORICAL[mode].length} validated hues — hues would repeat. Fold the tail into "Other" or facet.`
		});
	} else if (count > 4) {
		findings.push({
			level: 'warn',
			rule: 'too-many-series',
			message: `${count} series on one chart. Above ~4 the legend outruns the reader — fold the tail into "Other" or facet with column=/row=.`
		});
	}

	// The light-mode relief rule: slots 3-5 fall below 3:1 on white.
	if (reliefRequired(mode, count) && !hasRelief) {
		const labelled = (option.series ?? []).some((s) => s.label?.show);
		if (!labelled) {
			findings.push({
				level: 'warn',
				rule: 'relief-rule',
				message: `Light mode with ${count} series reaches the aqua/yellow/magenta slots, which sit below 3:1 on white. Ship visible labels (labels=true) or a companion table.`
			});
		}
	}

	// One axis. A second *scale* is the thing banned, not a second axis object —
	// facets legitimately produce an array of axes, one per panel.
	const yAxes = Array.isArray(option.yAxis) ? option.yAxis : option.yAxis ? [option.yAxis] : [];
	const grids = Array.isArray(option.grid) ? option.grid.length : 1;
	if (yAxes.length > grids) {
		findings.push({
			level: 'error',
			rule: 'dual-axis',
			message: 'Two y-scales share one plot. Two measures of different scale → two charts, or index both to 100.'
		});
	}

	// Numbers wear formats.
	const formatted = yAxes.some((a) => a.type !== 'value' || typeof a.axisLabel?.formatter === 'function');
	if (yAxes.length && !formatted) {
		findings.push({
			level: 'warn',
			rule: 'unformatted-measure',
			message: 'Measure axis has no format. Pass fmt= (usd0k, pct1, num0) — this project never ships a raw float.'
		});
	}

	// A chart of bare numbers names nothing on its own.
	if (!option._flintTitle) {
		findings.push({
			level: 'warn',
			rule: 'missing-title',
			message: `${chartType || 'This chart'} has no title. The headline is where the measure gets named.`
		});
	}

	return findings;
};

/** Re-exported so callers theming a chart never reach past this module. */
export { CATEGORICAL, SEQUENTIAL, STATUS, CHROME };
