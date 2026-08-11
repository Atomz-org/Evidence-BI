/**
 * Arrow schema -> Evidence column types.
 *
 * This is the reason to route Evidence through ADBC at all. The built-in
 * connectors receive untyped rows and *sniff* types from the first values, which
 * they mark `INFERRED`; a column of nulls, or integers that happen to arrive as
 * strings, gets the wrong answer. ADBC hands back an Arrow schema, so the type
 * is known rather than guessed and the result is `PRECISE`.
 *
 * Arrow type ids: https://github.com/apache/arrow/blob/main/js/src/enum.ts
 */
const { EvidenceType, TypeFidelity } = require('@evidence-dev/db-commons');

// Arrow's `Type` enum, by id. Written out rather than imported so this file does
// not depend on which apache-arrow version the driver manager resolved.
const ARROW = {
	NONE: 0,
	Null: 1,
	Int: 2,
	Float: 3,
	Binary: 4,
	Utf8: 5,
	Bool: 6,
	Decimal: 7,
	Date: 8,
	Time: 9,
	Timestamp: 10,
	Interval: 11,
	List: 12,
	Struct: 13,
	Union: 14,
	FixedSizeBinary: 15,
	FixedSizeList: 16,
	Map: 17,
	Duration: 18,
	LargeBinary: 19,
	LargeUtf8: 20,
	LargeList: 21
};

/**
 * @param {import('apache-arrow').DataType} type
 * @returns {{ evidenceType: string, precise: boolean }}
 */
const arrowTypeToEvidence = (type) => {
	const id = type?.typeId ?? type?.TType ?? -1;

	switch (id) {
		case ARROW.Bool:
			return { evidenceType: EvidenceType.BOOLEAN, precise: true };

		case ARROW.Int:
		case ARROW.Float:
		case ARROW.Decimal:
			return { evidenceType: EvidenceType.NUMBER, precise: true };

		case ARROW.Date:
		case ARROW.Timestamp:
			return { evidenceType: EvidenceType.DATE, precise: true };

		case ARROW.Utf8:
		case ARROW.LargeUtf8:
			return { evidenceType: EvidenceType.STRING, precise: true };

		// Time and Duration have no Evidence equivalent; they are rendered as
		// text rather than silently coerced into a Date at an arbitrary epoch.
		case ARROW.Time:
		case ARROW.Duration:
		case ARROW.Interval:
			return { evidenceType: EvidenceType.STRING, precise: true };

		// Structured and binary values are stringified on the way out (see
		// toJsValue), so string is the honest declaration, not a fallback.
		case ARROW.List:
		case ARROW.LargeList:
		case ARROW.FixedSizeList:
		case ARROW.Struct:
		case ARROW.Map:
		case ARROW.Union:
		case ARROW.Binary:
		case ARROW.LargeBinary:
		case ARROW.FixedSizeBinary:
			return { evidenceType: EvidenceType.STRING, precise: true };

		// An all-null column genuinely has no type. Saying so — rather than
		// guessing string — is what INFERRED is for.
		case ARROW.Null:
			return { evidenceType: EvidenceType.STRING, precise: false };

		default:
			return { evidenceType: EvidenceType.STRING, precise: false };
	}
};

/**
 * @param {import('apache-arrow').Schema} schema
 * @returns {{ name: string, evidenceType: string, typeFidelity: string }[]}
 */
const columnTypesFromSchema = (schema) =>
	(schema?.fields ?? []).map((field) => {
		const { evidenceType, precise } = arrowTypeToEvidence(field.type);
		return {
			name: field.name,
			evidenceType,
			typeFidelity: precise ? TypeFidelity.PRECISE : TypeFidelity.INFERRED
		};
	});

/**
 * Arrow value -> something JSON and Evidence can carry.
 *
 * Arrow hands back BigInt for 64-bit ints, Arrow Vectors for nested values and
 * epoch-millisecond numbers for timestamps depending on unit. Evidence expects
 * plain JS.
 */
const toJsValue = (value) => {
	if (value === null || value === undefined) return null;

	if (typeof value === 'bigint') {
		// Beyond 2^53 a Number is no longer the same integer. Losing the value
		// silently is worse than rendering it as text.
		return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value.toString();
	}

	if (value instanceof Date) return value;

	// Arrow Vector / Struct / Map proxies expose toJSON or toArray.
	if (typeof value === 'object') {
		if (typeof value.toJSON === 'function') {
			try {
				return JSON.stringify(value.toJSON());
			} catch {
				/* fall through */
			}
		}
		if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	return value;
};

/**
 * Convert an Arrow Table into plain row objects, using the schema to decide how
 * each column is read rather than inspecting values one at a time.
 *
 * @param {import('apache-arrow').Table} table
 */
const tableToRows = (table) => {
	const columnTypes = columnTypesFromSchema(table.schema);
	const dateColumns = new Set(
		columnTypes.filter((c) => c.evidenceType === EvidenceType.DATE).map((c) => c.name)
	);

	const rows = [];
	for (const row of table) {
		if (!row) continue;
		const out = {};
		for (const { name } of columnTypes) {
			const raw = row[name];
			out[name] = dateColumns.has(name) ? toDate(raw) : toJsValue(raw);
		}
		rows.push(out);
	}
	return { rows, columnTypes };
};

/** Arrow dates arrive as Date, epoch ms number, or BigInt depending on unit. */
const toDate = (value) => {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'bigint') return new Date(Number(value));
	if (typeof value === 'number') return new Date(value);
	return new Date(String(value));
};

module.exports = { arrowTypeToEvidence, columnTypesFromSchema, tableToRows, toJsValue, toDate, ARROW };
