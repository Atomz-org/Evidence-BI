/**
 * Time ranges, the way Rill means them.
 *
 * Two decisions in here are the whole reason this is a file and not four lines
 * inline.
 *
 * **Ranges anchor to the data, not to the clock.** "Last 7 days" in Rill means
 * the seven days ending at the newest row, not the seven days ending now. On a
 * warehouse that lags by a day the difference is a partly-empty final bucket;
 * on this project's parquet, which stopped on 2026-08-04, anchoring to `now`
 * would open every dashboard on an empty window and make the tool look broken.
 * The anchor is the watermark, and the UI says which date that is rather than
 * letting the reader assume it is today.
 *
 * **Everything is UTC.** The timeseries column is a naive TIMESTAMP; duckdb-wasm
 * hands it back as a Date at the same wall-clock instant in UTC. Doing the
 * arithmetic in local time and writing the boundary back out as a literal is
 * how a month bucket lands in the previous month on a machine east of
 * Greenwich — the same trap cube/README.md documents for the SQL API, reached
 * by a different road. Every function here reads and writes UTC components, and
 * tests/t-rill.mjs re-runs the boundary maths under five timezones.
 */

/** ISO 8601 durations, plus Rill's `inf` for "all of it". */
const DURATION = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * @typedef {{ years: number, months: number, days: number, ms: number }} Duration
 */

/**
 * Parse an ISO 8601 duration.
 *
 * Months and years stay symbolic rather than collapsing to a day count: three
 * calendar months is not 90 days, and a comparison window that silently drifts
 * by a day or two each quarter is the kind of thing nobody notices until a
 * quarter-on-quarter number is challenged.
 *
 * @param {string} text
 * @returns {Duration | null} null for `inf` or anything unparseable
 */
export const parseDuration = (text) => {
	if (!text || text === 'inf') return null;
	const m = DURATION.exec(String(text).trim());
	if (!m) return null;
	const [, y, mo, w, d, h, mi, s] = m.map((v) => (v === undefined ? 0 : Number(v)));
	if (!y && !mo && !w && !d && !h && !mi && !s) return null;
	return {
		years: y,
		months: mo,
		days: w * 7 + d,
		ms: ((h * 60 + mi) * 60 + s) * 1000
	};
};

/** Human label for a range token: `P4W` -> "Last 4 weeks". */
export const rangeLabel = (token) => {
	if (token === 'inf') return 'All time';
	const m = DURATION.exec(String(token).trim());
	if (!m) return token;
	const parts = [];
	const push = (n, unit) => {
		if (n) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
	};
	push(Number(m[1] ?? 0), 'year');
	push(Number(m[2] ?? 0), 'month');
	push(Number(m[3] ?? 0), 'week');
	push(Number(m[4] ?? 0), 'day');
	push(Number(m[5] ?? 0), 'hour');
	return parts.length ? `Last ${parts.join(' ')}` : token;
};

/** Subtract a duration from a UTC instant, calendar-correctly. */
export const subtract = (date, duration) => {
	if (!duration) return new Date(date.getTime());
	const out = new Date(date.getTime() - duration.ms);
	if (duration.days) out.setUTCDate(out.getUTCDate() - duration.days);
	if (duration.months || duration.years) {
		const day = out.getUTCDate();
		out.setUTCDate(1);
		out.setUTCMonth(out.getUTCMonth() - duration.months - duration.years * 12);
		// Clamp: one month before 31 March is 28 February, not 3 March.
		const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
		out.setUTCDate(Math.min(day, lastDay));
	}
	return out;
};

/** The start of the UTC day after `date` — an exclusive upper bound. */
export const endOfDayAfter = (date) => {
	const out = new Date(date.getTime());
	out.setUTCHours(0, 0, 0, 0);
	out.setUTCDate(out.getUTCDate() + 1);
	return out;
};

/** Grains, coarsest last, with the span at which each stops being readable. */
const GRAIN_ORDER = ['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
const DAY = 86400000;

/**
 * Pick the bucket size for a span.
 *
 * The thresholds are about how many marks a chart can carry, not about the
 * calendar: roughly 7–90 buckets is legible, fewer is a bar chart pretending to
 * be a trend, more is a smear.
 */
export const grainFor = (spanMs, smallest = 'day') => {
	const days = spanMs / DAY;
	const chosen = days <= 3 ? 'hour' : days <= 92 ? 'day' : days <= 730 ? 'week' : 'month';
	// Never finer than the metrics view allows: a view whose smallest grain is a
	// day cannot honestly draw hours.
	return GRAIN_ORDER.indexOf(chosen) < GRAIN_ORDER.indexOf(smallest) ? smallest : chosen;
};

/**
 * Resolve a range token against the data's own bounds.
 *
 * A short window has history behind it and a long one may not, so the result
 * carries how much of each window the data actually covers. Reporting coverage
 * beats the two obvious alternatives: hiding the comparison entirely throws away
 * a usable number whenever the prior window is 90% present, and showing it
 * silently lets a prior window that is half empty read as growth. On this
 * project's 46 days of parquet that is not a corner case — every range longer
 * than three weeks has a partial predecessor.
 *
 * @param {string} token e.g. 'P4W' or 'inf'
 * @param {{ min: Date, max: Date }} bounds the timeseries column's actual extent
 * @param {string} [smallestGrain]
 * @returns {{
 *   token: string, label: string, start: Date, end: Date, grain: string,
 *   coverage: number,
 *   comparison: { start: Date, end: Date } | null,
 *   comparisonCoverage: number,
 *   comparisonNote: string | null
 * }}
 */
export const resolveRange = (token, bounds, smallestGrain = 'day') => {
	const end = endOfDayAfter(bounds.max);
	const duration = parseDuration(token);

	let start;
	if (!duration) {
		// `inf` — everything, floored to the start of the first day of data so the
		// first bucket is a whole one.
		start = new Date(bounds.min.getTime());
		start.setUTCHours(0, 0, 0, 0);
	} else {
		// Deliberately not clamped to the first row. "Last 3 months" naming a
		// window that is really six weeks would make the label the lie instead.
		start = subtract(end, duration);
	}

	const span = end.getTime() - start.getTime();
	const grain = grainFor(span, smallestGrain);

	/** How much of a window falls inside the data. */
	const covered = (from, to) => {
		const overlap = Math.min(to.getTime(), end.getTime()) - Math.max(from.getTime(), bounds.min.getTime());
		return Math.max(0, Math.min(1, overlap / (to.getTime() - from.getTime())));
	};

	let comparison = null;
	let comparisonCoverage = 0;
	let comparisonNote = null;

	if (!duration) {
		comparisonNote = 'All time has nothing before it to compare against.';
	} else {
		const comparisonStart = subtract(start, duration);
		comparisonCoverage = covered(comparisonStart, start);
		if (comparisonCoverage === 0) {
			comparisonNote = `Nothing precedes ${formatUtcDate(start)} in this data, so there is no window to compare against.`;
		} else {
			comparison = { start: comparisonStart, end: new Date(start.getTime()) };
			if (comparisonCoverage < 0.999) {
				comparisonNote =
					`The comparison window starts ${formatUtcDate(comparisonStart)}, ` +
					`before the data begins on ${formatUtcDate(bounds.min)} — it holds ` +
					`${Math.round(comparisonCoverage * 100)}% of a full period, so every change reads high.`;
			}
		}
	}

	return {
		token,
		label: rangeLabel(token),
		start,
		end,
		grain,
		coverage: covered(start, end),
		comparison,
		comparisonCoverage,
		comparisonNote
	};
};

/** `2026-08-04` from a Date, in UTC. */
export const formatUtcDate = (date) => date.toISOString().slice(0, 10);

/**
 * A naive-timestamp SQL literal.
 *
 * The column is TIMESTAMP without a zone, so the literal must be too. Emitting
 * an offset here would make DuckDB compare a zoned value against a naive one
 * and shift the boundary by the offset.
 */
export const sqlTimestamp = (date) => `timestamp '${date.toISOString().slice(0, 19).replace('T', ' ')}'`;

/** The bucket expression for a grain. */
export const truncExpression = (expression, grain) => `date_trunc('${grain}', ${expression})`;

/**
 * Every bucket in a window, so a gap in the data reads as a gap rather than as
 * two adjacent days joined by a straight line.
 */
export const bucketsBetween = (start, end, grain) => {
	const out = [];
	const cursor = new Date(start.getTime());
	// Snap to the grain so the generated buckets line up with date_trunc's.
	if (grain === 'hour') cursor.setUTCMinutes(0, 0, 0);
	else cursor.setUTCHours(0, 0, 0, 0);
	if (grain === 'week') cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
	if (grain === 'month') cursor.setUTCDate(1);
	if (grain === 'year') cursor.setUTCMonth(0, 1);

	let guard = 0;
	while (cursor < end && guard < 5000) {
		out.push(new Date(cursor.getTime()));
		if (grain === 'hour') cursor.setUTCHours(cursor.getUTCHours() + 1);
		else if (grain === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
		else if (grain === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
		else if (grain === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
		else if (grain === 'quarter') cursor.setUTCMonth(cursor.getUTCMonth() + 3);
		else cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
		guard += 1;
	}
	return out;
};
