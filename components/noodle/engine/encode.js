/**
 * Turn a result set into a chart.
 *
 * The aesthetic decisions live here rather than in the UI, so that every view
 * built on the surface looks like it belongs to the same system without anyone
 * formatting anything: one type scale, gridlines only on the measure axis, no
 * chart borders, no axis lines competing with the marks, legends only when a
 * colour is actually encoding something, and value labels wherever a mark would
 * otherwise be unreadable.
 */

import { CATEGORICAL, CHROME, SEQUENTIAL } from './theme.js';

/**
 * Reshape long rows into the series a chart needs.
 *
 * With no colour, each measure is its own series. With a colour dimension, the
 * single measure is split across that dimension's values — which is what makes
 * "drop a field on Color" produce a grouped or stacked chart with no other step.
 */
export const buildSeriesData = ({ rows, columns, spec }) => {
	const dims = columns.filter((c) => c.role === 'dimension');
	const measures = columns.filter((c) => c.role === 'measure');

	const colorColumn = spec.color ? columns.find((c) => c.pill.key === spec.color.key) : null;
	const axisColumn = dims.find((c) => c !== colorColumn) ?? dims[0] ?? null;

	if (!axisColumn || !measures.length) {
		return { categories: [], series: [], axisColumn, colorColumn, measures };
	}

	const categories = [...new Set(rows.map((r) => r[axisColumn.alias]))];
	const categoryIndex = new Map(categories.map((c, i) => [String(c), i]));

	if (colorColumn && colorColumn.role === 'dimension') {
		const measure = measures.find((m) => m !== colorColumn) ?? measures[0];
		const seriesNames = [...new Set(rows.map((r) => r[colorColumn.alias]))];

		const series = seriesNames.map((name) => {
			const values = new Array(categories.length).fill(null);
			for (const row of rows) {
				if (row[colorColumn.alias] !== name) continue;
				const i = categoryIndex.get(String(row[axisColumn.alias]));
				if (i !== undefined) values[i] = row[measure.alias];
			}
			return { name: label(name), values, column: measure };
		});

		return { categories, series, axisColumn, colorColumn, measures: [measure] };
	}

	const series = measures.map((measure) => {
		const values = new Array(categories.length).fill(null);
		for (const row of rows) {
			const i = categoryIndex.get(String(row[axisColumn.alias]));
			if (i !== undefined) values[i] = row[measure.alias];
		}
		return { name: measure.label ?? measure.alias, values, column: measure };
	});

	return { categories, series, axisColumn, colorColumn: null, measures };
};

const label = (value) => (value === null || value === undefined ? '(none)' : String(value));

/**
 * Format a category for an axis. Dates get a grain-appropriate label rather than
 * a full timestamp, which is the difference between a readable axis and a wall
 * of text.
 */
export const axisLabeller = (column) => {
	if (column?.dataType !== 'date') return (v) => label(v);

	const part = column.pill?.datePart ?? 'month';
	const options =
		{
			year: { year: 'numeric' },
			quarter: { year: '2-digit', month: 'short' },
			month: { year: '2-digit', month: 'short' },
			week: { month: 'short', day: 'numeric' },
			day: { month: 'short', day: 'numeric' },
			hour: { month: 'short', day: 'numeric', hour: 'numeric' }
		}[part] ?? { year: '2-digit', month: 'short' };

	const formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
	return (v) => (v === null || v === undefined ? '(none)' : formatter.format(new Date(v)));
};

/**
 * Build the ECharts option for a mark.
 *
 * @param {object} args
 * @param {string} args.mark
 * @param {Record<string, unknown>[]} args.rows
 * @param {object[]} args.columns
 * @param {object} args.spec
 * @param {'light'|'dark'} args.mode
 * @param {(value: unknown, format?: string) => string} args.fmt
 * @returns {object|null}
 */
export const buildChartOption = ({ mark, rows, columns, spec, mode = 'light', fmt }) => {
	const chrome = CHROME[mode];
	const palette = CATEGORICAL[mode];
	const format = fmt ?? ((v) => String(v ?? ''));

	if (mark === 'heatmap') return heatmapOption({ rows, columns, spec, chrome, mode, format });

	const { categories, series, axisColumn, measures } = buildSeriesData({ rows, columns, spec });
	if (!series.length || !categories.length) return null;

	const labelFor = axisLabeller(axisColumn);
	const horizontal = mark === 'hbar';
	const measureFormat = measures[0]?.format;

	if (mark === 'point') return scatterOption({ rows, columns, spec, chrome, palette, format });

	const categoryAxis = {
		type: 'category',
		data: categories.map(labelFor),
		axisLine: { show: true, lineStyle: { color: chrome.axis } },
		axisTick: { show: false },
		axisLabel: {
			color: chrome.muted,
			fontSize: 11,
			hideOverlap: true,
			// Long category names get truncated rather than rotated: rotation is
			// harder to read than an ellipsis plus a tooltip.
			formatter: (v) => (String(v).length > 18 ? `${String(v).slice(0, 17)}…` : v)
		},
		splitLine: { show: false }
	};

	const valueAxis = {
		type: 'value',
		axisLine: { show: false },
		axisTick: { show: false },
		axisLabel: { color: chrome.muted, fontSize: 11, formatter: (v) => format(v, measureFormat) },
		splitLine: { lineStyle: { color: chrome.grid, type: 'solid' } }
	};

	const stacked = spec.stacked && series.length > 1 && (mark === 'bar' || mark === 'hbar' || mark === 'area');

	return {
		animationDuration: 300,
		grid: { left: 8, right: 16, top: series.length > 1 ? 34 : 12, bottom: 4, containLabel: true },
		color: palette,
		legend:
			series.length > 1
				? {
						show: true,
						top: 0,
						left: 0,
						icon: 'circle',
						itemWidth: 8,
						itemHeight: 8,
						textStyle: { color: chrome.muted, fontSize: 11 }
					}
				: { show: false },
		tooltip: {
			trigger: 'axis',
			axisPointer: { type: mark === 'line' || mark === 'area' ? 'line' : 'shadow' },
			backgroundColor: chrome.tooltipBg,
			borderColor: chrome.tooltipBorder,
			textStyle: { color: chrome.text, fontSize: 12 },
			formatter: (params) => {
				const head = params[0]?.axisValueLabel ?? '';
				const lines = params
					.filter((p) => p.value !== null && p.value !== undefined)
					.map(
						(p) =>
							`<div style="display:flex;gap:8px;justify-content:space-between">` +
							`<span>${p.marker} ${escapeHtml(p.seriesName)}</span>` +
							`<strong>${escapeHtml(format(p.value, measureFormat))}</strong></div>`
					)
					.join('');
				return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(head)}</div>${lines}`;
			}
		},
		xAxis: horizontal ? valueAxis : categoryAxis,
		yAxis: horizontal ? categoryAxis : valueAxis,
		series: series.map((s, i) => ({
			name: s.name,
			type: mark === 'area' ? 'line' : mark === 'hbar' ? 'bar' : mark,
			data: s.values,
			stack: stacked ? 'total' : undefined,
			smooth: false,
			symbol: mark === 'line' || mark === 'area' ? 'none' : 'circle',
			symbolSize: 6,
			lineStyle: mark === 'line' || mark === 'area' ? { width: 2 } : undefined,
			areaStyle: mark === 'area' ? { opacity: stacked ? 0.85 : 0.18 } : undefined,
			barMaxWidth: 42,
			itemStyle: { color: palette[i % palette.length], borderRadius: mark === 'bar' ? [2, 2, 0, 0] : mark === 'hbar' ? [0, 2, 2, 0] : 0 },
			emphasis: { focus: 'series' },
			// One series and few enough bars to label: show the numbers. A chart
			// whose values are legible does not need its table opened.
			label:
				series.length === 1 && categories.length <= 14 && (mark === 'bar' || mark === 'hbar')
					? {
							show: true,
							position: horizontal ? 'right' : 'top',
							color: chrome.muted,
							fontSize: 10,
							formatter: (p) => format(p.value, measureFormat)
						}
					: { show: false }
		}))
	};
};

const scatterOption = ({ rows, columns, spec, chrome, palette, format }) => {
	const measures = columns.filter((c) => c.role === 'measure');
	if (measures.length < 2) return null;

	const [xm, ym] = measures;
	const colorColumn = spec.color ? columns.find((c) => c.pill.key === spec.color.key) : null;
	const sizeColumn = spec.size ? columns.find((c) => c.pill.key === spec.size.key) : null;
	const detailColumn = columns.find((c) => c.role === 'dimension');

	// Only colour splits the points into series; detail names the individual
	// point in the tooltip. Without a colour column every point belongs to one
	// series, so the legend stays out of the way.
	const groups = new Map();
	for (const row of rows) {
		const key = colorColumn ? label(row[colorColumn.alias]) : 'All';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(row);
	}

	const sizes = sizeColumn ? rows.map((r) => Number(r[sizeColumn.alias]) || 0) : [];
	const maxSize = sizes.length ? Math.max(...sizes) : 0;

	return {
		animationDuration: 300,
		color: palette,
		grid: { left: 8, right: 16, top: groups.size > 1 ? 34 : 12, bottom: 4, containLabel: true },
		legend:
			groups.size > 1
				? { show: true, top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: chrome.muted, fontSize: 11 } }
				: { show: false },
		tooltip: {
			trigger: 'item',
			backgroundColor: chrome.tooltipBg,
			borderColor: chrome.tooltipBorder,
			textStyle: { color: chrome.text, fontSize: 12 },
			formatter: (p) => {
				const [x, y, , name] = p.value;
				return (
					`<div style="font-weight:600;margin-bottom:4px">${escapeHtml(name ?? p.seriesName)}</div>` +
					`<div>${escapeHtml(xm.label ?? xm.alias)}: <strong>${escapeHtml(format(x, xm.format))}</strong></div>` +
					`<div>${escapeHtml(ym.label ?? ym.alias)}: <strong>${escapeHtml(format(y, ym.format))}</strong></div>`
				);
			}
		},
		xAxis: {
			type: 'value',
			name: xm.label,
			nameLocation: 'middle',
			nameGap: 26,
			nameTextStyle: { color: chrome.muted, fontSize: 11 },
			axisLine: { show: false },
			axisTick: { show: false },
			axisLabel: { color: chrome.muted, fontSize: 11, formatter: (v) => format(v, xm.format) },
			splitLine: { lineStyle: { color: chrome.grid } }
		},
		yAxis: {
			type: 'value',
			name: ym.label,
			nameTextStyle: { color: chrome.muted, fontSize: 11, align: 'left' },
			axisLine: { show: false },
			axisTick: { show: false },
			axisLabel: { color: chrome.muted, fontSize: 11, formatter: (v) => format(v, ym.format) },
			splitLine: { lineStyle: { color: chrome.grid } }
		},
		series: [...groups.entries()].map(([name, groupRows], i) => ({
			name,
			type: 'scatter',
			data: groupRows.map((r) => [
				r[xm.alias],
				r[ym.alias],
				sizeColumn ? Number(r[sizeColumn.alias]) || 0 : 0,
				detailColumn ? label(r[detailColumn.alias]) : name
			]),
			symbolSize: sizeColumn
				? (v) => 6 + (maxSize ? Math.sqrt(v[2] / maxSize) * 26 : 0)
				: 9,
			itemStyle: { color: palette[i % palette.length], opacity: 0.8 },
			emphasis: { focus: 'series' }
		}))
	};
};

const heatmapOption = ({ rows, columns, spec, chrome, mode, format }) => {
	const dims = columns.filter((c) => c.role === 'dimension');
	const measures = columns.filter((c) => c.role === 'measure');
	if (dims.length < 2 || !measures.length) return null;

	const xColumn = dims.find((c) => c.shelf === 'columns') ?? dims[0];
	const yColumn = dims.find((c) => c !== xColumn) ?? dims[1];
	const measure = measures[0];

	const xLabel = axisLabeller(xColumn);
	const yLabel = axisLabeller(yColumn);

	const xs = [...new Set(rows.map((r) => r[xColumn.alias]))];
	const ys = [...new Set(rows.map((r) => r[yColumn.alias]))];
	const xIndex = new Map(xs.map((v, i) => [String(v), i]));
	const yIndex = new Map(ys.map((v, i) => [String(v), i]));

	const values = rows.map((r) => Number(r[measure.alias])).filter(Number.isFinite);
	const min = Math.min(0, ...values);
	const max = Math.max(...values, 1);

	return {
		animationDuration: 300,
		grid: { left: 8, right: 16, top: 12, bottom: 48, containLabel: true },
		tooltip: {
			backgroundColor: chrome.tooltipBg,
			borderColor: chrome.tooltipBorder,
			textStyle: { color: chrome.text, fontSize: 12 },
			formatter: (p) =>
				`<div style="font-weight:600;margin-bottom:4px">${escapeHtml(xLabel(xs[p.value[0]]))} · ${escapeHtml(yLabel(ys[p.value[1]]))}</div>` +
				`<strong>${escapeHtml(format(p.value[2], measure.format))}</strong>`
		},
		xAxis: {
			type: 'category',
			data: xs.map(xLabel),
			splitArea: { show: false },
			axisLine: { show: false },
			axisTick: { show: false },
			axisLabel: { color: chrome.muted, fontSize: 11, hideOverlap: true }
		},
		yAxis: {
			type: 'category',
			data: ys.map(yLabel),
			splitArea: { show: false },
			axisLine: { show: false },
			axisTick: { show: false },
			axisLabel: { color: chrome.muted, fontSize: 11 }
		},
		visualMap: {
			min,
			max,
			calculable: false,
			orient: 'horizontal',
			left: 'center',
			bottom: 0,
			itemWidth: 10,
			itemHeight: 90,
			textStyle: { color: chrome.muted, fontSize: 10 },
			formatter: (v) => format(v, measure.format),
			inRange: { color: SEQUENTIAL[mode] }
		},
		series: [
			{
				type: 'heatmap',
				data: rows.map((r) => [
					xIndex.get(String(r[xColumn.alias])),
					yIndex.get(String(r[yColumn.alias])),
					Number(r[measure.alias]) || 0
				]),
				itemStyle: { borderColor: chrome.surface, borderWidth: 1 },
				emphasis: { itemStyle: { borderColor: chrome.text, borderWidth: 1 } }
			}
		]
	};
};

const escapeHtml = (value) =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
