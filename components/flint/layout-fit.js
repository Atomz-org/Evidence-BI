/**
 * Fit a Flint-assembled ECharts option into a box it must not exceed.
 *
 * Flint plans a canvas and is free to grow it. That is the right behaviour on a
 * page that scrolls, and it is the reason `grow` defaults to true. A dashboard
 * tile is the other case: the row is 360px and will not negotiate.
 *
 * The two were never reconciled, and the failure is quiet. `chart_spec.baseSize`
 * is the **plot area**; Flint adds axis labels, axis names, the legend and the
 * colour key *outside* it and reports the total as `option._height`. Ask for
 * 252 and it plans 403 — the overflow is a constant 151px of chrome and no
 * amount of shrinking the ask removes it:
 *
 *     ask     200   252   300   360   420   500
 *     _height 351   403   451   511   571   651
 *
 * Draw that 403px plan into a 252px canvas and nothing scales. Every position
 * in the option is absolute, so the plot is crushed to the leftover and the
 * furniture below it lands off the canvas or on top of the labels: the date
 * axis title floating in space, "Order status" written through the words
 * "pending" and "cancelled". Both were on the board.
 *
 * `theme_spec` cannot help. Its `annotation.axisTitles` and `legend.placement`
 * houses are Vega-Lite-only — the ECharts assembler accepts them and returns a
 * byte-identical option, which is the same trap the palette fell into and the
 * reason `theme-bridge.js` exists.
 *
 * So the margins are computed here, from the text that will actually be drawn:
 * every category label is in `axis.data`, the caller supplies a worst-case
 * sample for the value axes, and the measurement is the browser's own
 * `measureText` in the page's own font. What Flint decided — the mark, the
 * scales, the domain, the series, whether to facet — is untouched.
 *
 * Division of labour, extending the one in FlintChart.svelte:
 *
 *   Flint          structure — mark, scales, faceting, which labels
 *   theme-bridge   ink — palette, chrome, fonts, number formats
 *   layout-fit     margins — making the plan true at the size we have
 *
 * Faceted options keep Flint's plan untouched: a facet grid is a layout, not a
 * margin, and re-deriving one by hand is exactly the hand-tuning this project
 * uses Flint to avoid. Those charts grow instead.
 */

/** Geometry constants, all in px. Named because a bare 8 in a margin sum is unreadable. */
export const FIT = {
	tick: 8, // ECharts' axis tick length
	labelGap: 6, // tick end → label
	namePad: 8, // label band → axis name
	edge: 6, // canvas edge → outermost furniture
	legendGap: 14, // plot → legend column
	swatch: 26, // legend icon plus its gap to the text
	colourKey: 46, // a horizontal visualMap parked along the bottom
	minPlotW: 140,
	minPlotH: 70,
	/** A legend wider than this share of the box has stopped being a key. */
	maxLegendShare: 0.32
};

/**
 * Rough text width without a canvas — for node tests and for any call that
 * happens before the font resolves.
 *
 * Deliberately a little generous: a margin computed too wide costs a few pixels
 * of plot, one computed too narrow puts the axis name through the labels.
 */
export const estimateWidth = (text, fontSize = 12) => String(text ?? '').length * fontSize * 0.58;

/**
 * A measuring function bound to a real font.
 *
 * ECharts draws to a canvas, so the canvas' own metrics are the ones that
 * matter — a proportional font makes "Guest checkout" and "OTHER" differ by
 * more than their character counts suggest.
 */
export const measureWith = (fontFamily) => {
	if (typeof document === 'undefined') return estimateWidth;
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return estimateWidth;
	return (text, fontSize = 12) => {
		ctx.font = `${fontSize}px ${fontFamily || 'sans-serif'}`;
		return ctx.measureText(String(text ?? '')).width;
	};
};

const first = (value) => (Array.isArray(value) ? value[0] : value);
const count = (value) => (Array.isArray(value) ? value.length : value ? 1 : 0);

/**
 * A time axis draws whatever its pattern says, and the pattern is right there.
 *
 * `{MMM} {dd}` is six characters and `{yyyy}-{MM}-{dd}` is ten — reserving the
 * same margin for both is how an axis ends up either cramped or padded. ECharts
 * chooses the ticks, so the values are unknown, but the *shape* of a label is
 * not.
 */
const TOKEN_WIDTHS = { yyyy: '2026', yy: '26', MMM: 'Www', MM: '00', M: '0', dd: '00', d: '0', HH: '00', mm: '00', ss: '00', SSS: '000' };
const patternSample = (formatter) => {
	if (typeof formatter !== 'string' || !formatter.includes('{')) return null;
	return formatter.replace(/\{(\w+)\}/g, (whole, token) => TOKEN_WIDTHS[token] ?? whole);
};

/** Category axes carry their labels; everything else needs a sample from the caller. */
const labelsOf = (axis, sample) => {
	if (Array.isArray(axis?.data) && axis.data.length) {
		return axis.data.map((d) => (d && typeof d === 'object' ? (d.value ?? '') : d));
	}
	if (sample) return Array.isArray(sample) ? sample : [sample];
	const pattern = patternSample(axis?.axisLabel?.formatter);
	return pattern ? [pattern] : [];
};

/** The vertical room a row of labels needs, given how far they are turned. */
const bandHeight = (rotate, maxWidth, lineHeight) => {
	const turn = (Math.abs(rotate ?? 0) % 180) * (Math.PI / 180);
	return Math.ceil(Math.abs(maxWidth * Math.sin(turn)) + Math.abs(lineHeight * Math.cos(turn)));
};

/**
 * Should this axis' labels stay turned on their side?
 *
 * Flint turns dense axes to ninety degrees, which is correct when the labels
 * would collide and costly when they would not — vertical text is slower to
 * read and, at these tile heights, spends more of the box than the plot does.
 *
 * Two cases, and the difference matters:
 *
 *   category  every label is drawn, so whether they collide is arithmetic:
 *             the widths plus their gaps against the plot width.
 *   time      ECharts chooses the ticks itself and thins them until they fit,
 *             so a horizontal time axis cannot collide. Flint had already
 *             thinned to seven labels across 600px and turned them anyway.
 */
const shouldRotate = (axis, widths, plotWidth) => {
	if (axis.type === 'time') return false;
	if (!widths.length) return false;
	const needed = widths.reduce((sum, w) => sum + w, 0) + widths.length * 10;
	return needed > plotWidth;
};

/**
 * An axis whose labels already say what kind of thing they are does not need a
 * title saying it again.
 *
 * This is Flint's own `whenAmbiguous` rule — "a list of names does, a ramp of
 * numbers does not" — which its ECharts assembler declares and never applies.
 * Applied narrowly, to the one case that is not a judgement call: a time axis
 * labelled `Jul 09  Jul 13` titled "Date". A field named "Signup date" is
 * saying whose date and keeps its title.
 */
const GENERIC_TIME_NAME = /^(date|time|timestamp|datetime|day|week|month|quarter|year|period|bucket)$/i;
const redundantName = (axis) => axis?.type === 'time' && GENERIC_TIME_NAME.test(String(axis.name ?? ''));

/**
 * Rewrite the option's margins so the whole chart lands inside `width × height`.
 *
 * Mutates and returns a report — `fitted: false` means the option was left
 * exactly as Flint assembled it and the caller should give it the canvas it
 * planned.
 *
 * @param {object} option  an `assembleECharts` result, already themed
 * @param {object} args
 * @param {number} args.width           the box, in px
 * @param {number} args.height          the box, in px
 * @param {(t:string,s?:number)=>number} [args.measure]  text metrics in the page's font
 * @param {{x?:string|string[], y?:string|string[]}} [args.samples]
 *        worst-case label text for axes that do not enumerate their own — a
 *        value axis has a domain, not a list
 */
export const fitToBox = (option, { width, height, measure = estimateWidth, samples = {} } = {}) => {
	const notes = [];
	if (!option || !(width > 0) || !(height > 0)) return { fitted: false, reason: 'no box', notes };

	if (count(option.grid) > 1) {
		return { fitted: false, reason: 'faceted', notes: ['a facet grid is a layout, not a margin — left to Flint'] };
	}

	const grid = first(option.grid);
	const xAxis = first(option.xAxis);
	const yAxis = first(option.yAxis);

	/* ------------------------------------------------------------- legend -- */

	let rightReserve = FIT.edge;
	const legend = first(option.legend);
	if (legend && Array.isArray(legend.data) && legend.data.length) {
		const font = legend.textStyle?.fontSize ?? 11;
		const widest = Math.max(...legend.data.map((name) => measure(name, font)));
		const cap = Math.round(width * FIT.maxLegendShare);
		const column = Math.min(Math.ceil(widest) + FIT.swatch, cap);
		if (Math.ceil(widest) + FIT.swatch > cap) {
			// Truncation with an ellipsis, not a legend that eats the plot. The
			// tooltip still carries the full series name.
			legend.textStyle = { ...(legend.textStyle ?? {}), width: cap - FIT.swatch, overflow: 'truncate' };
			notes.push('legend truncated to keep the plot');
		}

		// Flint anchors the legend at an absolute `left`, computed against the
		// canvas it planned. Any other canvas width puts it over the plot or off
		// the edge — so it is re-anchored to the box's right edge instead.
		const header = (option.graphic ?? []).find((g) => g.type === 'text');
		delete legend.left;
		legend.right = FIT.edge;
		legend.top = header ? 22 : FIT.edge + 2;
		legend.orient = 'vertical';
		legend.itemGap = legend.itemGap ?? 8;
		if (header) {
			delete header.left;
			header.right = FIT.edge;
			header.top = 4;
		}
		rightReserve = column + FIT.legendGap;
	}

	/* -------------------------------------------------------- the colour key -- */

	let bottomReserve = 0;
	const visualMap = first(option.visualMap);
	if (visualMap && visualMap.bottom !== undefined) {
		visualMap.bottom = FIT.edge;
		visualMap.itemWidth = visualMap.itemWidth ?? 10;
		visualMap.itemHeight = visualMap.itemHeight ?? Math.min(180, Math.round(width * 0.35));
		bottomReserve = FIT.colourKey;
	}

	if (!grid) {
		// Pie, treemap and friends: no axes to measure, but the legend still had
		// to be re-anchored above.
		return { fitted: true, reason: 'no grid', notes };
	}

	/* --------------------------------------------------------------- axes -- */

	for (const axis of [xAxis, yAxis]) if (redundantName(axis)) {
		notes.push(`dropped the redundant "${axis.name}" title from the time axis`);
		delete axis.name;
	}

	const xFont = xAxis?.axisLabel?.fontSize ?? 12;
	const yFont = yAxis?.axisLabel?.fontSize ?? 12;
	const xNameFont = xAxis?.nameTextStyle?.fontSize ?? 12;
	const yNameFont = yAxis?.nameTextStyle?.fontSize ?? 12;

	const xLabels = labelsOf(xAxis, samples.x);
	const yLabels = labelsOf(yAxis, samples.y);
	const xWidths = xLabels.map((l) => measure(l, xFont));
	const yWidths = yLabels.map((l) => measure(l, yFont));
	const yMax = yWidths.length ? Math.ceil(Math.max(...yWidths)) : 0;
	const xMax = xWidths.length ? Math.ceil(Math.max(...xWidths)) : Math.ceil(measure('Www 00', xFont));

	// A continuous axis centres its labels on the ticks, and the last tick is the
	// plot's own right edge — so half of "$100k" hangs past it and off the canvas.
	// A category axis centres each label inside its band instead, and cannot
	// overhang. Half a label, once, is the whole difference between a chart that
	// ends in "$100k" and one that ends in "$10".
	if (xAxis && xAxis.type !== 'category') rightReserve = Math.max(rightReserve, Math.ceil(xMax / 2) + FIT.edge);

	// Left next: it does not depend on the rotation decision, and the decision
	// depends on how much plot is left after it.
	const yBand = FIT.tick + FIT.labelGap + yMax;
	let left = yBand + FIT.edge;
	if (yAxis?.name) {
		yAxis.nameLocation = 'middle';
		yAxis.nameGap = Math.ceil(yBand + FIT.namePad + yNameFont * 0.5);
		left = Math.ceil(yAxis.nameGap + yNameFont * 0.7 + FIT.edge);
	}

	const plotWidth = Math.max(FIT.minPlotW, width - left - rightReserve);
	if (xAxis?.axisLabel) {
		const rotate = shouldRotate(xAxis, xWidths, plotWidth) ? (xAxis.axisLabel.rotate || 45) : 0;
		if (rotate !== xAxis.axisLabel.rotate) {
			notes.push(`x labels ${rotate ? `turned to ${rotate}°` : 'laid flat — they fit'}`);
			xAxis.axisLabel.rotate = rotate;
		}
	}

	const xBand = FIT.tick + FIT.labelGap + bandHeight(xAxis?.axisLabel?.rotate, xMax, Math.ceil(xFont * 1.2));
	let bottom = xBand + FIT.edge + bottomReserve;
	if (xAxis?.name) {
		xAxis.nameLocation = 'middle';
		xAxis.nameGap = Math.ceil(xBand + FIT.namePad + xNameFont * 0.5);
		bottom = Math.ceil(xAxis.nameGap + xNameFont * 0.7 + FIT.edge + bottomReserve);
	}

	// The topmost tick label straddles the plot's top edge; half of it plus a
	// little breathing room is all the space needed up there, because the title
	// and subtitle are DOM elements above the canvas rather than furniture on it.
	let top = Math.ceil(yFont * 0.7) + FIT.edge;

	/* ------------------------------------------------------------ clamping -- */

	// A box can be too small for its own chrome — a 300px row with a colour key,
	// two axis names and six status labels. Give the plot back its minimum by
	// dropping the least load-bearing furniture first: axis names restate what
	// the panel title and the labels already say, so they go before the labels do.
	if (height - top - bottom < FIT.minPlotH) {
		for (const [axis, font] of [[xAxis, xNameFont], [yAxis, yNameFont]]) {
			if (!axis?.name) continue;
			delete axis.name;
			notes.push('dropped an axis title — the box is too short to carry it');
			if (axis === xAxis) bottom = xBand + FIT.edge + bottomReserve;
			else left = yBand + FIT.edge;
			void font;
			if (height - top - bottom >= FIT.minPlotH) break;
		}
	}
	if (height - top - bottom < FIT.minPlotH) {
		bottom = Math.max(FIT.tick + FIT.labelGap, height - top - FIT.minPlotH);
		notes.push('the box is shorter than its labels need — the label band was cut');
	}
	if (width - left - rightReserve < FIT.minPlotW) {
		left = Math.max(FIT.tick, width - rightReserve - FIT.minPlotW);
		notes.push('the box is narrower than its labels need — the label band was cut');
	}

	grid.left = Math.round(left);
	grid.right = Math.round(rightReserve);
	grid.top = Math.round(top);
	grid.bottom = Math.round(bottom);
	// Every margin above is measured, so letting ECharts also expand the grid to
	// contain the labels would apply the same allowance twice and shrink the plot
	// for no reason.
	grid.containLabel = false;

	return {
		fitted: true,
		notes,
		box: { width, height },
		plot: { width: width - grid.left - grid.right, height: height - grid.top - grid.bottom }
	};
};
