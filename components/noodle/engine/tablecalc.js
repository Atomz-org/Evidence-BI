/**
 * Table calculations — computed after the query, over the result table.
 *
 * A running total or a moving average is defined relative to the *layout*: it
 * moves along one direction and restarts along the others. Tableau calls these
 * addressing and partitioning, and specifying them by **field** rather than by
 * screen position is what stops the calculation breaking when the view is
 * rearranged. Swap Rows and Columns, add a colour, change the mark — the
 * addressing fields still exist, so the calculation still means what it meant.
 */

/** Calculations available on a measure pill. */
export const TABLE_CALCS = {
	runningTotal: { label: 'Running total', needsWindow: false },
	movingAverage: { label: 'Moving average', needsWindow: true },
	percentOfTotal: { label: 'Percent of total', needsWindow: false },
	difference: { label: 'Difference from previous', needsWindow: false },
	percentDifference: { label: 'Percent difference', needsWindow: false },
	rank: { label: 'Rank', needsWindow: false }
};

/**
 * Resolve which columns a calculation moves along, and which it restarts within.
 *
 * The default is deliberately **not** "along the table" — a position-relative
 * default is exactly what breaks when Rows and Columns are swapped. Instead the
 * default binds to a field: time if the view has any, since a running total or
 * moving average almost always runs along time, and time keeps its meaning
 * wherever the field is placed. An explicit `addressing` always wins.
 *
 * @param {object[]} columns compiled columns, in view order
 * @param {object} calc
 * @returns {{ addressing: string[], partitioning: string[] }}
 */
export const resolveDirection = (columns, calc) => {
	const dimensions = columns.filter((c) => c.role === 'dimension');
	const dimensionAliases = dimensions.map((c) => c.alias);
	if (!dimensionAliases.length) return { addressing: [], partitioning: [] };

	const requested = (calc.addressing ?? []).filter((a) => dimensionAliases.includes(a));

	let addressing = requested;
	if (!addressing.length) {
		const temporal = dimensions.filter((c) => c.dataType === 'date').map((c) => c.alias);
		if (temporal.length) {
			addressing = temporal;
		} else {
			// No time: fall back to the columns shelf, which reads left-to-right.
			const across = dimensions.filter((c) => c.shelf === 'columns').map((c) => c.alias);
			addressing = across.length ? across : [dimensionAliases[dimensionAliases.length - 1]];
		}
	}

	const partitioning = dimensionAliases.filter((a) => !addressing.includes(a));
	return { addressing, partitioning };
};

/** Comparable key for grouping rows into partitions. */
const partitionKey = (row, aliases) => JSON.stringify(aliases.map((a) => normalise(row[a])));

const normalise = (value) => (value instanceof Date ? value.getTime() : value);

const compareValues = (a, b) => {
	const x = normalise(a);
	const y = normalise(b);
	if (x === y) return 0;
	if (x === null || x === undefined) return -1;
	if (y === null || y === undefined) return 1;
	return x < y ? -1 : 1;
};

/**
 * Apply every table calculation in the spec to a result set.
 *
 * The calculated value replaces the measure in place — that is what the view is
 * now showing — and the pre-calculation value is kept under `<alias>__base` so
 * a tooltip can still report it.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {object[]} columns
 * @returns {{ rows: Record<string, unknown>[], columns: object[] }}
 */
export const applyTableCalcs = (rows, columns) => {
	const calcColumns = columns.filter((c) => c.role === 'measure' && c.pill?.calc);
	if (!calcColumns.length || !rows.length) return { rows, columns };

	// Work on a copy so re-running against the same result is idempotent.
	const out = rows.map((row) => ({ ...row }));

	for (const column of calcColumns) {
		const calc = column.pill.calc;
		const { addressing, partitioning } = resolveDirection(columns, calc);
		const alias = column.alias;

		// Index rows by partition, then order along the addressing fields.
		const partitions = new Map();
		for (const row of out) {
			const key = partitionKey(row, partitioning);
			if (!partitions.has(key)) partitions.set(key, []);
			partitions.get(key).push(row);
		}

		for (const partition of partitions.values()) {
			partition.sort((a, b) => {
				for (const field of addressing) {
					const cmp = compareValues(a[field], b[field]);
					if (cmp !== 0) return cmp;
				}
				return 0;
			});

			const values = partition.map((row) => toNumber(row[alias]));
			const computed = computeSeries(values, calc);

			partition.forEach((row, i) => {
				row[`${alias}__base`] = row[alias];
				row[alias] = computed[i];
			});
		}
	}

	const nextColumns = columns.map((c) =>
		calcColumns.includes(c) ? { ...c, calculated: true, format: calcFormat(c) } : c
	);

	return { rows: out, columns: nextColumns };
};

const toNumber = (value) => {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : null;
};

/** A percent calculation is a percent, whatever the underlying measure was. */
const calcFormat = (column) => {
	const type = column.pill.calc?.type;
	if (type === 'percentOfTotal' || type === 'percentDifference') return 'pct1';
	if (type === 'rank') return 'num0';
	return column.pill.format ?? column.format;
};

/**
 * @param {(number|null)[]} values ordered along the addressing fields
 * @param {object} calc
 * @returns {(number|null)[]}
 */
export const computeSeries = (values, calc) => {
	switch (calc.type) {
		case 'runningTotal': {
			let total = 0;
			return values.map((v) => {
				if (v === null) return null;
				total += v;
				return total;
			});
		}

		case 'movingAverage': {
			const window = Math.max(1, Math.floor(calc.window ?? 3));
			return values.map((_, i) => {
				const from = Math.max(0, i - window + 1);
				const slice = values.slice(from, i + 1).filter((v) => v !== null);
				if (!slice.length) return null;
				return slice.reduce((a, b) => a + b, 0) / slice.length;
			});
		}

		case 'percentOfTotal': {
			const total = values.reduce((a, b) => a + (b ?? 0), 0);
			return values.map((v) => (v === null || !total ? null : v / total));
		}

		case 'difference':
			return values.map((v, i) => (i === 0 || v === null || values[i - 1] === null ? null : v - values[i - 1]));

		case 'percentDifference':
			return values.map((v, i) => {
				const prev = values[i - 1];
				if (i === 0 || v === null || prev === null || !prev) return null;
				return (v - prev) / prev;
			});

		case 'rank': {
			// Competition ranking: ties share a rank, the next value skips.
			const order = values
				.map((v, i) => ({ v, i }))
				.filter((e) => e.v !== null)
				.sort((a, b) => (calc.ascending ? a.v - b.v : b.v - a.v));

			const ranks = new Array(values.length).fill(null);
			let lastValue = null;
			let lastRank = 0;
			order.forEach((entry, position) => {
				const rank = entry.v === lastValue ? lastRank : position + 1;
				ranks[entry.i] = rank;
				lastValue = entry.v;
				lastRank = rank;
			});
			return ranks;
		}

		default:
			return values;
	}
};
