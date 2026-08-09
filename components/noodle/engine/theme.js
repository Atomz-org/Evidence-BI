/**
 * The chart palette.
 *
 * These are the same values as `theme.colorPalettes` in `evidence.config.yaml`,
 * which is a validated instance of the project's colour method: every adjacent
 * pair clears dE >= 8 under the common CVD simulations and >= 15 for normal
 * vision, on this project's real surfaces. Slot **order** is the mechanism —
 * never reorder, never append a ninth hue.
 *
 * Charts drawn here are canvas, not DOM, so they cannot inherit the CSS
 * variables the rest of the page uses. The values are mirrored rather than
 * derived; if the config changes, change them here too.
 */

export const CATEGORICAL = {
	light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
	dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
};

/** Sequential = one hue. On the dark surface the ramp is reversed. */
export const SEQUENTIAL = {
	light: ['#cde2fb', '#3987e5', '#0d366b'],
	dark: ['#104281', '#3987e5', '#9ec5f4']
};

/** Reserved for deltas and alerts — never reused as a series colour. */
export const STATUS = {
	positive: '#0ca30c',
	negative: '#d03b3b',
	warning: '#fab219'
};

/** Surface-dependent chrome: axes, gridlines, labels. */
export const CHROME = {
	light: {
		text: '#3f3f46',
		muted: '#71717a',
		grid: '#e4e4e7',
		axis: '#d4d4d8',
		surface: '#ffffff',
		tooltipBg: '#ffffff',
		tooltipBorder: '#e4e4e7'
	},
	dark: {
		text: '#d4d4d8',
		muted: '#a1a1aa',
		grid: '#27272a',
		axis: '#3f3f46',
		surface: '#09090b',
		tooltipBg: '#18181b',
		tooltipBorder: '#3f3f46'
	}
};

/**
 * Slots 3, 4 and 5 (aqua, yellow, magenta) fall below 3:1 against white. A light
 * chart leaning on them needs visible labels or a companion table — the project
 * calls this the relief rule, and the surface says so rather than silently
 * shipping something unreadable.
 */
export const NEEDS_RELIEF = new Set([2, 3, 4]);

/**
 * @param {'light'|'dark'} mode
 * @param {number} seriesCount
 * @returns {boolean} whether the relief rule applies to this chart
 */
export const reliefRequired = (mode, seriesCount) =>
	mode === 'light' && [...NEEDS_RELIEF].some((slot) => slot < seriesCount);

/**
 * Detect the surface the page is currently painted on.
 *
 * Evidence's theme switcher toggles a class on the document element; reading the
 * computed background is more reliable than guessing from a media query, which
 * would be wrong whenever the user has overridden the system preference.
 *
 * The subtlety is transparency. `<html>` frequently has no background of its own
 * — the colour is painted on `<body>` — and `getComputedStyle` reports that as
 * `rgba(0, 0, 0, 0)`. Reading only the channels turns "not painted" into pure
 * black, and every chart on a white page comes out dressed for a dark one. So the
 * alpha decides whether an element has an opinion at all, and the search walks
 * outward until something does.
 */
export const detectMode = () => {
	if (typeof document === 'undefined') return 'light';
	const root = document.documentElement;
	if (root.classList.contains('dark')) return 'dark';
	if (root.dataset.theme === 'dark') return 'dark';

	for (const element of [root, document.body]) {
		if (!element) continue;
		const match = getComputedStyle(element).backgroundColor.match(/[\d.]+/g);
		if (!match || match.length < 3) continue;
		const [r, g, b, a = 1] = match.map(Number);
		if (Number(a) === 0) continue; // transparent: no opinion, keep looking
		// Rec. 601 luma is good enough to tell a dark surface from a light one.
		return 0.299 * r + 0.587 * g + 0.114 * b < 128 ? 'dark' : 'light';
	}

	// Nothing on the page is painted yet — fall back to the system preference.
	return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
