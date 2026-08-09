/**
 * "Show Me" — rank the mark types that suit the fields currently on the shelves.
 *
 * The ranking is not a preference list. It follows the form heuristic: pick the
 * mark from the *job the data is doing* — change over time, magnitude
 * comparison, composition, distribution, correlation, or lookup — and let
 * cardinality decide the variant. Every candidate carries the reason it was
 * offered, and every rejection carries what would unlock it, because a
 * recommender that only says "no" teaches nothing.
 */

/** Cardinality past which a vertical bar's labels stop being readable. */
const WIDE_CATEGORY = 12;
/** Cardinality past which any categorical mark should give way to a table. */
const VERY_WIDE_CATEGORY = 60;

export const MARKS = {
	bigvalue: { label: 'Number', icon: 'number' },
	bar: { label: 'Bar', icon: 'bar' },
	hbar: { label: 'Horizontal bar', icon: 'hbar' },
	line: { label: 'Line', icon: 'line' },
	area: { label: 'Area', icon: 'area' },
	point: { label: 'Scatter', icon: 'point' },
	heatmap: { label: 'Heatmap', icon: 'heatmap' },
	table: { label: 'Table', icon: 'table' }
};

/**
 * @param {import('./types.js').Catalog} catalog
 * @param {import('./types.js').Spec} spec
 * @param {object} [stats] optional per-alias cardinality from the last result
 * @returns {{ mark: string, score: number, reason: string }[]}
 */
export const recommend = (catalog, spec, stats = {}) => {
	const dims = [...spec.columns, ...spec.rows, ...spec.detail, spec.color, spec.size]
		.filter(Boolean)
		.filter((p) => p.role === 'dimension');
	const measures = [...spec.columns, ...spec.rows, spec.color, spec.size]
		.filter(Boolean)
		.filter((p) => p.role === 'measure');

	const temporal = dims.filter((p) => catalog.byId[p.fieldId]?.dataType === 'date');
	const categorical = dims.filter((p) => catalog.byId[p.fieldId]?.dataType !== 'date');

	const cardinality = (pill) => stats[pill?.fieldId]?.distinct ?? null;
	const widest = Math.max(0, ...categorical.map((p) => cardinality(p) ?? 0));

	/** @type {{mark: string, score: number, reason: string}[]} */
	const out = [];
	const offer = (mark, score, reason) => out.push({ mark, score, reason });

	// ------------------------------------------------------- a single number --
	if (dims.length === 0 && measures.length >= 1) {
		offer('bigvalue', 100, 'One number and no dimension — show it as a figure, with a comparison.');
		offer('table', 40, 'Every view should be inspectable as a table.');
		return sort(out);
	}

	if (measures.length === 0) {
		offer('table', 100, 'Dimensions with no measure — this is a lookup, not a chart.');
		offer('bar', 45, 'Add a measure, or use Count of Records, to compare magnitudes.');
		return sort(out);
	}

	// ----------------------------------------------------- change over time --
	if (temporal.length >= 1) {
		offer('line', 100, 'A date on a shelf means change over time — a line reads the trend directly.');
		if (measures.length === 1 && categorical.length <= 1) {
			offer(
				'area',
				spec.color ? 78 : 70,
				spec.color
					? 'Stacked area shows how the total is composed as it moves.'
					: 'Area emphasises accumulated magnitude rather than rate of change.'
			);
		}
		offer('bar', 65, 'Bars suit discrete periods — months billed, weeks shipped — better than a line.');
		if (categorical.length >= 1 && measures.length === 1) {
			offer('heatmap', 55, 'A date against a category makes a calendar-style heatmap of intensity.');
		}
		offer('table', 35, 'The numbers behind the trend.');
		return sort(out);
	}

	// -------------------------------------------------------- correlation ----
	if (measures.length >= 2 && categorical.length >= 1) {
		offer('point', 95, 'Two measures against each other — a scatter shows the relationship, one mark per category.');
		offer('bar', 60, 'Compare the measures side by side instead of against each other.');
		offer('table', 45, 'Both measures per row.');
		return sort(out);
	}

	// ------------------------------------------- magnitude comparison --------
	if (categorical.length === 1 && measures.length >= 1) {
		if (widest > VERY_WIDE_CATEGORY) {
			offer('table', 95, `${widest} categories is past what any chart can carry — rank them in a table.`);
			offer('hbar', 80, 'A sorted horizontal bar works if you cut this to a top N.');
		} else if (widest > WIDE_CATEGORY) {
			offer('hbar', 100, `${widest} categories — horizontal bars keep the labels readable.`);
			offer('bar', 70, 'Vertical bars will crowd or rotate the labels at this width.');
		} else {
			offer('bar', 100, 'One category against one measure — the plainest magnitude comparison there is.');
			offer('hbar', 82, 'Horizontal if the labels are long.');
		}
		if (spec.color?.role === 'dimension') {
			offer('area', 50, 'Stacked, if the parts summing to the whole is the point.');
		}
		offer('point', 45, 'A dot plot avoids the ink of bars when only position matters.');
		offer('table', 40, 'The exact values.');
		return sort(out);
	}

	// ------------------------------------------------------- two categories --
	if (categorical.length >= 2 && measures.length === 1) {
		offer('heatmap', 100, 'Two categories and one measure — a heatmap shows the whole matrix at once.');
		offer('bar', 80, 'Grouped or stacked bars, if one category matters more than the other.');
		offer('table', 60, 'A crosstab, when the exact numbers are the point.');
		return sort(out);
	}

	offer('bar', 70, 'A reasonable default for this combination.');
	offer('table', 60, 'Always available.');
	return sort(out);
};

const sort = (list) => list.sort((a, b) => b.score - a.score);

/**
 * The mark to draw: the author's explicit choice, else the top recommendation.
 */
export const resolveMark = (catalog, spec, stats) => {
	if (spec.mark && spec.mark !== 'auto') return spec.mark;
	return recommend(catalog, spec, stats)[0]?.mark ?? 'table';
};

/**
 * Why a mark is unavailable, phrased as what would unlock it.
 *
 * @returns {string | null} null when the mark is available
 */
export const blockedReason = (catalog, spec, mark) => {
	const dims = [...spec.columns, ...spec.rows, ...spec.detail].filter(Boolean);
	const measures = [...spec.columns, ...spec.rows, spec.color, spec.size]
		.filter(Boolean)
		.filter((p) => p.role === 'measure');
	const categorical = dims.filter(
		(p) => p.role === 'dimension' && catalog.byId[p.fieldId]?.dataType !== 'date'
	);

	switch (mark) {
		case 'point':
			return measures.length >= 2 ? null : 'Add a second measure — a scatter needs one per axis.';
		case 'heatmap':
			return categorical.length + dims.filter((p) => catalog.byId[p.fieldId]?.dataType === 'date').length >= 2
				? null
				: 'Add a second dimension — a heatmap needs a row field and a column field.';
		case 'bigvalue':
			return dims.length === 0 ? null : 'Remove the dimensions — a figure shows one number.';
		case 'line':
		case 'area':
			return dims.length >= 1 ? null : 'Add a dimension for the line to travel along.';
		default:
			return measures.length >= 1 ? null : 'Add a measure.';
	}
};
