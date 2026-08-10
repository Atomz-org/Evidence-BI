/**
 * Getting the numbers off the page.
 *
 * A chart on a dashboard answers one question. The next question is nearly
 * always somebody else's, asked in a spreadsheet, and the usual answer — screen
 * grab, or re-run the query by hand — is where a governed number stops being
 * governed. So every tile that holds rows can hand them over.
 *
 * On Google Sheets specifically, and why this works the way it does:
 *
 * There is no unauthenticated way to create a populated spreadsheet. The Sheets
 * API needs OAuth and a server to hold the secret; this site is static files and
 * a WASM database, and adding a backend so a button can say "Sheets" would be a
 * bad trade. `IMPORTDATA()` needs the data to already be at a public URL, which
 * it is not — the rows are computed in the reader's own browser, after their
 * own filters.
 *
 * What does work everywhere, with no account linking and no data leaving the
 * machine until the reader pastes it: put the rows on the clipboard as TSV and
 * open a blank sheet. Sheets parses a tab-separated paste into cells, including
 * quoted fields containing commas and newlines. One keystroke, and the reader
 * can see exactly what is being handed over first.
 *
 * The same serializer backs the CSV download, so the two exports cannot drift.
 */

/** A blank spreadsheet in the reader's own Google account. */
export const GOOGLE_SHEETS_NEW = 'https://docs.google.com/spreadsheets/u/0/create';

/**
 * One cell.
 *
 * DuckDB-wasm hands back BigInt for integers, Date for timestamps and Arrow
 * values for the rest. A spreadsheet wants text it can re-type: `10n` must not
 * arrive as "10n", and a timestamp is only useful if Sheets recognises it as a
 * date, which it does for `YYYY-MM-DD HH:MM:SS`.
 */
export const cellText = (value) => {
	if (value === null || value === undefined) return '';
	if (typeof value === 'bigint') return String(value);
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return '';
		const iso = value.toISOString();
		// Midnight UTC is a date, not an instant — a spreadsheet column of
		// "2026-07-09 00:00:00" sorts and charts worse than one of "2026-07-09".
		return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
	}
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
};

/**
 * Quote a field when the delimiter, a quote or a newline would otherwise break
 * the row. RFC 4180 rules, and Google Sheets applies them to a tab-separated
 * paste as well — which is the only reason a value containing a comma survives
 * the round trip.
 */
const quote = (text, sep) =>
	text.includes(sep) || text.includes('"') || text.includes('\n') || text.includes('\r')
		? `"${text.replace(/"/g, '""')}"`
		: text;

/**
 * Which columns, in which order, under which headings.
 *
 * Given nothing, the keys of the widest row — "widest" because a first row that
 * happens to be missing an optional column would silently drop it for every
 * other row too.
 */
export const columnsOf = (rows, columns) => {
	if (Array.isArray(columns) && columns.length) {
		return columns.map((c) => (typeof c === 'string' ? { key: c, label: c } : { key: c.key, label: c.label ?? c.key }));
	}
	const keys = [];
	const seen = new Set();
	for (const row of rows ?? []) {
		for (const key of Object.keys(row ?? {})) {
			if (seen.has(key)) continue;
			seen.add(key);
			keys.push(key);
		}
	}
	return keys.map((key) => ({ key, label: key }));
};

/** Rows → delimited text, header row included. */
export const toDelimited = (rows, { columns, sep = '\t' } = {}) => {
	const cols = columnsOf(rows, columns);
	const lines = [cols.map((c) => quote(String(c.label), sep)).join(sep)];
	for (const row of rows ?? []) lines.push(cols.map((c) => quote(cellText(row?.[c.key]), sep)).join(sep));
	return lines.join('\n');
};

export const toTsv = (rows, columns) => toDelimited(rows, { columns, sep: '\t' });
export const toCsv = (rows, columns) => toDelimited(rows, { columns, sep: ',' });

/** A filename that survives every filesystem, from a human title. */
export const slug = (text, fallback = 'export') =>
	String(text ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || fallback;

/**
 * The clipboard, with a fallback.
 *
 * `navigator.clipboard` needs a secure context. Localhost is one and so is any
 * https deployment, but a site served over plain http on a LAN address is not —
 * and silently copying nothing, then opening a spreadsheet to paste into, is the
 * worst possible outcome. The old `execCommand` path still works there.
 */
export const copyText = async (text) => {
	try {
		if (navigator?.clipboard?.writeText && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* fall through */
	}
	try {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		area.remove();
		return ok;
	} catch {
		return false;
	}
};

/** Save text as a file, without a server. */
export const downloadText = (filename, text, mime = 'text/csv;charset=utf-8') => {
	const url = URL.createObjectURL(new Blob([text], { type: mime }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Revoking immediately races the download in Safari.
	setTimeout(() => URL.revokeObjectURL(url), 2000);
};

/**
 * Copy the rows and open a blank Google Sheet to paste them into.
 *
 * Order matters: the tab is opened first, inside the click that asked for it.
 * Awaiting the clipboard before `window.open` moves the call out of the user
 * gesture and the popup blocker eats it — which reads, from the outside, as a
 * button that copies but does not open.
 *
 * @returns {Promise<{copied:boolean, opened:boolean}>}
 */
export const toGoogleSheets = async (rows, { columns } = {}) => {
	const tsv = toTsv(rows, columns);
	let opened = false;
	try {
		const tab = window.open(GOOGLE_SHEETS_NEW, '_blank');
		if (tab) {
			// Not `noopener` in the feature string, because that returns null and
			// there is then no way to tell a blocked popup from an open one.
			tab.opener = null;
			opened = true;
		}
	} catch {
		opened = false;
	}
	const copied = await copyText(tsv);
	return { copied, opened };
};
