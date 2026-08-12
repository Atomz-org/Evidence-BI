/**
 * Rill's number formats.
 *
 * A metrics view declares how a measure reads — `format_preset: currency_usd`,
 * `format_d3: ".2f"` — and that declaration has to survive the trip into
 * Evidence, or the same measure prints one way in Rill and another way here.
 * Two renderings of one governed number is the exact failure the semantic layer
 * exists to prevent, so the formats are reimplemented rather than approximated.
 *
 * Two contexts, deliberately different:
 *
 *   compact — headline numbers and axis ticks, where 1.2M beats 1,234,567
 *   exact   — tables and tooltips, where the reader came for the digits
 *
 * Rill's own big numbers are compact and its tables are not; matching that is
 * what makes a value recognisable across the two tools.
 *
 * `format_d3` is a d3-format spec, and d3-format is not a dependency here. The
 * documented subset below covers the specs a metrics view realistically uses;
 * scripts/build-rill-model.mjs rejects anything outside it at build time, so an
 * unsupported spec is a project error rather than a number that quietly
 * renders wrong.
 */

/** The d3-format subset this file implements. Kept in sync with the generator. */
export const D3_SUBSET = /^([$])?(,)?(?:\.(\d+))?([fds%])?$/;

const NBSP = ' ';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Group digits with commas, at a fixed number of decimals. */
const fixed = (value, decimals) =>
	value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/**
 * Rill's humanize: three significant figures and an SI-ish suffix.
 *
 * The rounding is applied *before* the suffix is chosen, so 999,999 humanizes
 * as 1.0M rather than 1000.0k — the naive order produces a number one whole
 * suffix out of step, which is subtle enough to survive review.
 */
export const humanize = (value, { decimals = 1 } = {}) => {
	if (!isNumber(value)) return '—';
	if (value === 0) return '0';

	const sign = value < 0 ? '-' : '';
	let magnitude = Math.abs(value);

	const suffixes = ['', 'k', 'M', 'B', 'T'];
	let tier = 0;
	while (tier < suffixes.length - 1 && magnitude >= 1000) {
		magnitude /= 1000;
		tier += 1;
	}
	// Rounding can push 999.95 to 1000 — carry into the next tier.
	if (Number(magnitude.toFixed(decimals)) >= 1000 && tier < suffixes.length - 1) {
		magnitude /= 1000;
		tier += 1;
	}

	if (tier === 0) {
		// Below a thousand there is no suffix to shorten anything, so show what
		// the value actually is: whole numbers whole, fractions to two places.
		const decimalsHere = Number.isInteger(magnitude) ? 0 : magnitude < 1 ? 3 : 2;
		return sign + fixed(magnitude, decimalsHere);
	}
	return `${sign}${Number(magnitude.toFixed(decimals))}${suffixes[tier]}`;
};

/** Milliseconds as a duration, largest unit that leaves a readable number. */
export const humanizeInterval = (ms) => {
	if (!isNumber(ms)) return '—';
	const sign = ms < 0 ? '-' : '';
	const abs = Math.abs(ms);
	const units = [
		[86400000, 'd'],
		[3600000, 'h'],
		[60000, 'm'],
		[1000, 's']
	];
	for (const [size, suffix] of units) {
		if (abs >= size) return `${sign}${Number((abs / size).toFixed(abs / size < 10 ? 1 : 0))}${suffix}`;
	}
	return `${sign}${Number(abs.toFixed(0))}ms`;
};

/** Apply the supported d3-format subset. */
const applyD3 = (value, spec) => {
	const match = D3_SUBSET.exec(spec);
	if (!match) return humanize(value);
	const [, currency, group, precision, type] = match;
	const decimals = precision === undefined ? (type === 'f' || type === '%' ? 6 : 2) : Number(precision);

	if (type === 's') return (currency ?? '') + humanize(value, { decimals });
	if (type === '%') return `${group ? fixed(value * 100, decimals) : (value * 100).toFixed(decimals)}%`;
	if (type === 'd') return (currency ?? '') + (group ? fixed(Math.round(value), 0) : String(Math.round(value)));
	return (currency ?? '') + (group ? fixed(value, decimals) : value.toFixed(decimals));
};

/**
 * Format a value the way its measure says it should read.
 *
 * @param {number|null|undefined} value
 * @param {{ formatPreset?: string, formatD3?: string|null }} measure
 * @param {{ compact?: boolean }} [options]
 * @returns {string}
 */
export const formatMeasure = (value, measure, { compact = false } = {}) => {
	if (!isNumber(value)) return '—';
	// An explicit d3 spec is an explicit instruction; compactness does not
	// override it, or `.2f` would stop meaning two decimal places on a card.
	if (measure?.formatD3) return applyD3(value, measure.formatD3);

	switch (measure?.formatPreset) {
		case 'none':
			return fixed(value, Number.isInteger(value) ? 0 : 2);
		case 'currency_usd':
			return value < 0 ? `-$${money(-value, compact)}` : `$${money(value, compact)}`;
		case 'currency_eur':
			return value < 0 ? `-€${money(-value, compact)}` : `€${money(value, compact)}`;
		case 'percentage':
			// Roughly three significant figures, so precision follows magnitude: a
			// 5.72% cancellation rate keeps the digit that distinguishes it from
			// 5.68%, while 57.2% does not need a hundredth nobody will act on. The
			// switch is at 10%, where the third significant figure crosses the
			// decimal point.
			return `${Number((value * 100).toFixed(Math.abs(value) < 0.1 ? 2 : 1))}%`;
		case 'interval_ms':
			return humanizeInterval(value);
		case 'humanize':
		default:
			return compact ? humanize(value) : fixed(value, Number.isInteger(value) ? 0 : 2);
	}
};

const money = (magnitude, compact) =>
	compact && magnitude >= 1000 ? humanize(magnitude) : fixed(magnitude, magnitude < 1000 ? 2 : 0);

/**
 * A change between two windows, in the shape a delta chip needs.
 *
 * The two null cases are different and are kept different. No comparison window
 * means the question was not asked. A comparison window whose value is zero
 * means it was asked and has no percentage answer — 0 to 40 is not "up 100%",
 * it is up 40 from nothing, and printing a percentage there invents a
 * denominator.
 *
 * @returns {{ absolute: number|null, relative: number|null, direction: 'up'|'down'|'flat'|null }}
 */
export const delta = (current, previous) => {
	if (!isNumber(current) || !isNumber(previous)) return { absolute: null, relative: null, direction: null };
	const absolute = current - previous;
	const relative = previous === 0 ? null : absolute / Math.abs(previous);
	return { absolute, relative, direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat' };
};

/** Signed, in the measure's own format. */
export const formatDelta = (value, measure, options) =>
	!isNumber(value) ? '—' : (value > 0 ? '+' : '') + formatMeasure(value, measure, options);

/** A relative change as a signed percentage. */
export const formatPercent = (fraction, { decimals = 1 } = {}) => {
	if (!isNumber(fraction)) return '—';
	const pct = fraction * 100;
	const shown = Number(pct.toFixed(Math.abs(pct) < 1 ? decimals + 1 : decimals));
	return `${shown > 0 ? '+' : ''}${shown}%`;
};

/**
 * Whether a change should read as good.
 *
 * `lower_is_better` exists for measures like a cancellation rate, where the
 * green-is-up default is exactly backwards.
 */
export const isFavourable = (direction, measure) => {
	if (direction === 'flat' || !direction) return null;
	return measure?.lowerIsBetter ? direction === 'down' : direction === 'up';
};

/** A share of a total, for the leaderboard bars. `null` when the claim is unsound. */
export const percentOfTotal = (value, total, measure) => {
	if (!measure?.percentOfTotal) return null;
	if (!isNumber(value) || !isNumber(total) || total === 0) return null;
	return value / total;
};

/** Axis ticks want the compact form of whatever the measure is. */
export const axisFormatter = (measure) => (value) => formatMeasure(value, measure, { compact: true });

/** A date, at the precision the grain implies. */
export const formatInstant = (value, grain = 'day') => {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	const opts =
		grain === 'hour'
			? { month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC' }
			: grain === 'month' || grain === 'quarter'
				? { year: 'numeric', month: 'short', timeZone: 'UTC' }
				: grain === 'year'
					? { year: 'numeric', timeZone: 'UTC' }
					: { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
	return date.toLocaleDateString('en-US', opts).replace(/ /g, NBSP);
};
