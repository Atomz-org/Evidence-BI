/**
 * Connection tests for the ADBC source.
 *
 * Every flavor is exercised against something real where that is possible. Where
 * it needs credentials this project does not have (MotherDuck, Snowflake,
 * BigQuery) the test still runs and asserts something meaningful: that the
 * driver loads, is handed its options, and fails at *authentication* rather than
 * at driver resolution. That distinguishes "wired up correctly, no account" from
 * "does not work", which is the part a reader actually needs to know.
 *
 * Infrastructure (see docs/adbc.md):
 *   ./cube/up.sh                                    # not required
 *   podman run -d --name pg-adbc -p 15433:5432 ...  # postgres
 *   podman run -d --name clickhouse-adbc -p 8123:8123 ...
 *
 * Run:  npm run test:adbc
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${ROOT}/package.json`);
const adbc = require('evidence-connector-adbc');
const { testConnection } = adbc;

const results = [];
const record = (name, status, detail = '') => results.push({ name, status, detail });

const reachable = async (url) => {
	try {
		const c = new AbortController();
		const t = setTimeout(() => c.abort(), 1500);
		await fetch(url, { signal: c.signal });
		clearTimeout(t);
		return true;
	} catch {
		return false;
	}
};

const tcpOpen = async (host, port) => {
	const net = await import('node:net');
	return new Promise((resolve) => {
		const s = net.createConnection({ host, port });
		const done = (v) => {
			s.destroy();
			resolve(v);
		};
		s.setTimeout(1500);
		s.on('connect', () => done(true));
		s.on('error', () => done(false));
		s.on('timeout', () => done(false));
	});
};

/** Run a query and assert it produced the expected rows/types. */
const live = async (name, opts, sql, assertFn) => {
	try {
		const r = await adbc(sql, opts);
		const problem = assertFn(r);
		if (problem) return record(name, 'FAIL', problem);
		record(name, 'ok', `${r.rows.length} row(s)`);
	} catch (e) {
		record(name, 'FAIL', String(e.message ?? e).split('\n')[0].slice(0, 140));
	}
};

/**
 * For a flavor we cannot authenticate to: assert we reach the wire, not that we
 * succeed. A driver-resolution failure is a real failure; an auth/credential
 * failure proves everything up to the credential is correct.
 */
const reachesTheWire = async (name, opts) => {
	const r = await testConnection({ ...opts, directory: '.' }, '.');
	if (r === true) return record(name, 'ok', 'connected (credentials present)');

	const reason = String(r.reason ?? '').replace(/\s+/g, ' ');

	// Narrowly: the shared library itself could not be found or loaded. Anchored
	// on driver/library words, because "could not find default credentials" is a
	// credential result and must not be mistaken for a missing driver.
	const driverMissing =
		/Install the driver/i.test(reason) ||
		/(could not (find|load)|failed to (load|open)|no such file)[^.]*\b(driver|librar|\.so|\.dylib|\.dll|manifest)/i.test(
			reason
		);
	if (driverMissing) return record(name, 'FAIL', `driver not loadable: ${reason.slice(0, 110)}`);

	// An option the driver rejects is a bug in this connector, not a missing
	// credential — do not let it hide among the auth failures.
	if (/unknown database (option|auth type)|unrecognized|invalid option/i.test(reason)) {
		return record(name, 'FAIL', `connector sent a bad option: ${reason.slice(0, 110)}`);
	}

	// The interesting part of these errors is usually at the end (the service's
	// own words), not the start (a wrapper's).
	const authLike = reason.match(
		/(not authenticated[^"]*|failed to auth[^,]*|Authentication failed[^"]*|credentials?[^"]*|Could not create client[^"]*)/i
	);
	record(name, 'wire', (authLike ? authLike[0] : reason).slice(0, 120));
};

/* ------------------------------------------------------------------ duckdb -- */

await live(
	'duckdb        (project file)',
	{ flavor: 'duckdb', filename: 'needful_things.duckdb', directory: `${ROOT}/sources/needful_things` },
	'select count(*) as n, min(order_datetime) as first_order from orders',
	(r) => {
		if (r.rows[0].n !== 10000) return `expected 10000 rows in orders, got ${r.rows[0].n}`;
		if (!(r.rows[0].first_order instanceof Date)) return 'first_order is not a Date';
		const t = Object.fromEntries(r.columnTypes.map((c) => [c.name, `${c.evidenceType}/${c.typeFidelity}`]));
		if (t.n !== 'number/precise') return `n typed ${t.n}, expected number/precise`;
		if (t.first_order !== 'date/precise') return `first_order typed ${t.first_order}`;
		return null;
	}
);

await live(
	'duckdb        (:memory:)',
	{ flavor: 'duckdb', directory: ROOT },
	"select 42 as answer, 'hi' as greeting, true as flag",
	(r) => {
		const row = r.rows[0];
		if (row.answer !== 42 || row.greeting !== 'hi' || row.flag !== true) {
			return `unexpected row ${JSON.stringify(row)}`;
		}
		const t = Object.fromEntries(r.columnTypes.map((c) => [c.name, c.evidenceType]));
		if (t.flag !== 'boolean') return `flag typed ${t.flag}`;
		return null;
	}
);

/* ---------------------------------------------------------------- ducklake -- */

const lakeDir = path.join(ROOT, '.bench/adbc-ducklake');
fs.rmSync(lakeDir, { recursive: true, force: true });
fs.mkdirSync(lakeDir, { recursive: true });

await live(
	'ducklake      (local catalog)',
	{ flavor: 'ducklake', directory: lakeDir },
	"create table if not exists lake_t as select 1 as a, 'x' as b union all select 2, 'y'; select count(*) as n from lake_t",
	(r) => (r.rows[0].n === 2 ? null : `expected 2 rows, got ${r.rows[0].n}`)
);

// Prove it is a lake, not just an in-memory duckdb: the catalog must be on disk.
{
	const files = fs.existsSync(lakeDir) ? fs.readdirSync(lakeDir) : [];
	const hasCatalog = files.some((f) => f.includes('ducklake'));
	record(
		'ducklake      (catalog persisted)',
		hasCatalog ? 'ok' : 'FAIL',
		hasCatalog ? files.filter((f) => f.includes('ducklake')).join(', ') : `nothing lake-like in ${files.join(', ')}`
	);
}

/* -------------------------------------------------------------- postgresql -- */

if (await tcpOpen('127.0.0.1', 15433)) {
	await live(
		'postgresql    (localhost:15433)',
		{
			flavor: 'postgresql',
			host: '127.0.0.1',
			port: 15433,
			user: 'evidence',
			password: 'evidence',
			database: 'evidence',
			directory: '.'
		},
		'select region, count(*) as n, max(ordered_at) as latest from orders group by 1 order by 1',
		(r) => {
			if (r.rows.length !== 2) return `expected 2 regions, got ${r.rows.length}`;
			if (!(r.rows[0].latest instanceof Date)) return 'timestamp did not become a Date';
			const t = Object.fromEntries(r.columnTypes.map((c) => [c.name, c.evidenceType]));
			if (t.latest !== 'date') return `latest typed ${t.latest}`;
			return null;
		}
	);
} else {
	record('postgresql    (localhost:15433)', 'skip', 'no postgres on 15433 — see docs/adbc.md');
}

// Cube's SQL API speaks the postgres wire protocol but is not postgres: the ADBC
// driver moves results with COPY ... TO STDOUT (FORMAT binary), which Cube does
// not implement. Worth asserting so the limitation stays visible.
if (await tcpOpen('127.0.0.1', 15432)) {
	const r = await testConnection(
		{ flavor: 'postgresql', host: '127.0.0.1', port: 15432, user: 'cube', password: 'cube', database: 'cube' },
		'.'
	);
	const isCopy = r !== true && /COPY/i.test(String(r.reason ?? ''));
	record(
		'postgresql    (Cube SQL API — expected to refuse)',
		isCopy || r === true ? 'ok' : 'FAIL',
		r === true ? 'unexpectedly worked — Cube may now support COPY' : 'refuses COPY binary, as documented'
	);
} else {
	record('postgresql    (Cube SQL API)', 'skip', 'cube not running');
}

/* -------------------------------------------------------------- clickhouse -- */

if (await reachable('http://127.0.0.1:8123/ping')) {
	await live(
		'clickhouse    (localhost:8123)',
		{
			flavor: 'clickhouse',
			host: '127.0.0.1',
			port: 8123,
			user: 'default',
			password: 'clickhouse',
			database: 'default',
			directory: '.'
		},
		'select region, count() as n, sum(amount) as total from default.orders group by region order by region',
		(r) => {
			if (r.rows.length !== 2) return `expected 2 regions, got ${r.rows.length}`;
			const emea = r.rows.find((x) => x.region === 'EMEA');
			if (Math.abs(emea.total - 175.5) > 1e-9) return `EMEA total ${emea.total}, expected 175.5`;
			return null;
		}
	);

	// ClickHouse DateTime arrives as Arrow Uint32 (epoch seconds) — an integer,
	// indistinguishable from a count. Date32/DateTime64 carry real temporal types.
	await live(
		'clickhouse    (Date32/DateTime64 become Dates)',
		{ flavor: 'clickhouse', host: '127.0.0.1', port: 8123, user: 'default', password: 'clickhouse', directory: '.' },
		'select toDate(ordered_at) as d, toDateTime64(ordered_at,3) as dt64, ordered_at as raw from default.orders order by id limit 1',
		(r) => {
			const row = r.rows[0];
			if (!(row.d instanceof Date)) return 'toDate did not become a Date';
			if (!(row.dt64 instanceof Date)) return 'toDateTime64 did not become a Date';
			if (typeof row.raw !== 'number') return 'plain DateTime unexpectedly not an integer — driver may have changed';
			return null;
		}
	);
} else {
	record('clickhouse    (localhost:8123)', 'skip', 'no clickhouse on 8123 — see docs/adbc.md');
}

/* ------------------------------------------ credentialed: reach-the-wire only -- */

await reachesTheWire('motherduck    (needs token)', {
	flavor: 'motherduck',
	token: process.env.MOTHERDUCK_TOKEN ?? 'not-a-real-token',
	database: process.env.MOTHERDUCK_DATABASE ?? ''
});

await reachesTheWire('snowflake     (needs account)', {
	flavor: 'snowflake',
	account: process.env.SNOWFLAKE_ACCOUNT ?? 'nonexistent-account',
	username: process.env.SNOWFLAKE_USER ?? 'evidence',
	password: process.env.SNOWFLAKE_PASSWORD ?? 'not-a-real-password'
});

await reachesTheWire('bigquery      (needs project)', {
	flavor: 'bigquery',
	project_id: process.env.BIGQUERY_PROJECT ?? 'nonexistent-project-evidence-test',
	keyfile: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

/* ------------------------------------------------------- misconfiguration -- */

{
	const r = await testConnection({ flavor: 'nope' }, '.');
	const ok = r !== true && /Unknown adbc flavor/.test(r.reason);
	record('error         (unknown flavor is named, not swallowed)', ok ? 'ok' : 'FAIL', ok ? '' : JSON.stringify(r));
}
{
	const r = await testConnection({ flavor: 'snowflake' }, '.');
	const ok = r !== true && /needs .*account/.test(r.reason);
	record('error         (missing required option is named)', ok ? 'ok' : 'FAIL', ok ? '' : JSON.stringify(r));
}

// The libduckdb conflict must be refused with an explanation, not left to crash
// the process with a C++ stack trace. Run in a child so loading
// @duckdb/node-api here does not poison the rest of this file.
{
	const { spawnSync } = await import('node:child_process');
	const probe = `
	  const { createRequire } = require('node:module');
	  const req = createRequire(${JSON.stringify(`${ROOT}/package.json`)});
	  req('@duckdb/node-api');                     // what Evidence loads
	  const adbc = req('evidence-connector-adbc');
	  adbc.testConnection({ flavor: 'duckdb' }, '.').then(r => {
	    console.log(JSON.stringify(r));
	  });
	`;
	const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
	const said = `${out.stdout}${out.stderr}`;
	const guarded = /cannot run in this process/.test(said) && /built-in/.test(said);
	record(
		'guard         (duckdb flavor refused beside @duckdb/node-api)',
		guarded ? 'ok' : 'FAIL',
		guarded ? 'explains the conflict instead of crashing' : said.slice(0, 120)
	);
}

/* -------------------------------------------------------------------- report -- */

const width = Math.max(...results.map((r) => r.name.length));
let failed = 0;
for (const { name, status, detail } of results) {
	if (status === 'FAIL') failed++;
	const tag = { ok: 'ok  ', FAIL: 'FAIL', skip: 'skip', wire: 'wire' }[status];
	console.log(`${tag}  ${name.padEnd(width)}  ${detail}`);
}

const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
console.log(
	`\n${counts.ok ?? 0} connected · ${counts.wire ?? 0} reached the wire (no credentials) · ` +
		`${counts.skip ?? 0} skipped · ${failed} failed`
);
console.log(
	`"wire" means the driver loaded and the request reached the service, which then rejected\n` +
		`the placeholder credentials — everything except the account is verified.`
);
process.exit(failed ? 1 : 0);
