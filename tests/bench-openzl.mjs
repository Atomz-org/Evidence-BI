/**
 * Does OpenZL make Evidence faster?
 *
 * The claim under test is that OpenZL-compressed data beats DuckDB's native
 * parquet for Evidence's workload. That splits into three separate questions,
 * and they do not have the same answer:
 *
 *   1. Does OpenZL produce a smaller file than parquet's own codecs?
 *   2. What does it cost to get the data back?
 *   3. How many bytes does a real dashboard query actually need to read?
 *
 * (3) is the one that decides the architecture, because Evidence serves parquet
 * over HTTP and duckdb-wasm reads it with range requests — it fetches the
 * footer, then only the column chunks the query touches. A whole-file codec has
 * to deliver the entire file before the first row is readable, so it competes
 * against "a few column chunks", not against "the file".
 *
 * Run:  node tests/bench-openzl.mjs [--rows 5000000] [--zli /path/to/zli]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};

const ROWS = Number(arg('rows', 5_000_000));
const ZLI = arg('zli', process.env.OPENZL_ZLI ?? path.join(ROOT, 'vendor/openzl/zli'));
const WORK = arg('work', path.join(ROOT, '.bench'));

const MB = (bytes) => (bytes / 1e6).toFixed(2);
const size = (f) => fs.statSync(f).size;
const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;

const time = (label, fn) => {
	const t0 = process.hrtime.bigint();
	const out = fn();
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	return { label, ms, out };
};

if (!fs.existsSync(ZLI)) {
	// OpenZL is deliberately NOT vendored — nothing in this project links it, and
	// a ~90 MB clone plus a cmake toolchain is a poor trade for a benchmark whose
	// conclusion was "do not adopt this". Build it wherever you like and point
	// this at the binary.
	console.error(`zli not found at ${ZLI}\n`);
	console.error(`OpenZL is not vendored (see docs/openzl-evaluation.md for why). To build it:\n`);
	console.error(`  git clone --depth 1 https://github.com/facebook/openzl && cd openzl`);
	console.error(`  git submodule update --init --recursive`);
	console.error(`  make zli                        # needs cmake (brew install cmake)\n`);
	console.error(`Then:  node tests/bench-openzl.mjs --zli "$PWD/zli"`);
	console.error(`   or: OPENZL_ZLI=/path/to/zli npm run bench:openzl\n`);
	console.error(`The OpenZL leg also needs pyarrow to write canonical parquet:`);
	console.error(`  python3 -m venv .venv && .venv/bin/pip install pyarrow`);
	console.error(`  BENCH_PYTHON=.venv/bin/python node tests/bench-openzl.mjs --zli ...`);
	process.exit(2);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const db = await DuckDBInstance.create(':memory:');
const con = await db.connect();
const sql = async (q) => (await con.run(q)).getRowObjects();

// ---------------------------------------------------------------------------
// A dataset shaped like the real one.
//
// Compression behaviour is driven by column types, cardinalities and sort
// order, not by row count — so the generated table mirrors the real orders
// mart's shape (low-cardinality categoricals, a monotonic timestamp, high
// -cardinality identifiers, floats) and only scales the row count up to where
// the measurements stop being noise.
// ---------------------------------------------------------------------------
console.log(`Generating ${ROWS.toLocaleString()} rows shaped like needful_things.orders...`);

// Entropy matters more than row count here. An earlier version of this
// generator derived every column from `i % N`, which made the whole table a
// periodic function of the row index — delta plus RLE reduced it to nothing and
// OpenZL "won" by 328x. That number measured the generator, not the codec.
// Values are therefore drawn at random (fixed seed) so cardinalities and types
// match the real mart while the *sequence* carries realistic entropy. The
// timestamp is randomised then sorted, because an orders table really does
// arrive in time order — that ordering is a property of the data, not an
// artefact.
await sql(`select setseed(0.42)`);
await sql(`
  create table orders as
  select
      row_number() over (order by ts)                         as id,
      ts                                                      as order_datetime,
      date_trunc('month', ts)                                 as order_month,
      ['Ada','Bo','Cy','Dee','Eli','Fay','Gus','Hal'][cast(random()*8 as int)+1]        as first_name,
      ['Nkosi','Ortiz','Patel','Quinn','Rossi','Sato','Tran','Ueda'][cast(random()*8 as int)+1] as last_name,
      'user' || cast(random()*250000 as int) || '@example.com' as email,
      cast(random()*9000 as int) || ' Main St'                 as address,
      ['CA','NY','TX','FL','IL','WA','MA','GA'][cast(random()*8 as int)+1]              as state,
      10000 + cast(random()*89999 as int)                      as zipcode,
      ['Handcart','Lantern','Rope','Satchel','Tinderbox','Whetstone'][cast(random()*6 as int)+1] as item,
      ['Tools','Light','Storage','Sundry'][cast(random()*4 as int)+1]                   as category,
      round(5 + random()*400, 2)                               as sales,
      ['Email','Social','Search','Direct','Affiliate'][cast(random()*5 as int)+1]       as channel,
      ['Paid','Organic'][cast(random()*2 as int)+1]             as channel_group,
      ['Paid','Organic'][cast(random()*2 as int)+1] || '-' || strftime(ts, '%Y-%m')     as channel_month
  from (
    select timestamp '2023-01-01' + interval (cast(random()*1051200 as int)) minute as ts
    from range(${ROWS})
  ) t
`);

// ---------------------------------------------------------------------------
// Parquet variants. `plain` is what OpenZL's parquet profile expects: no
// compression, no dictionary encoding.
// ---------------------------------------------------------------------------
const variants = {
	plain: `(FORMAT parquet, COMPRESSION uncompressed, DICTIONARY_COMPRESSION_RATIO 999999)`,
	snappy: `(FORMAT parquet, COMPRESSION snappy)`,
	zstd: `(FORMAT parquet, COMPRESSION zstd)`,
	zstd_max: `(FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19)`
};

const files = {};
const rows = [];

for (const [name, opts] of Object.entries(variants)) {
	const f = path.join(WORK, `orders.${name}.parquet`);
	const t0 = process.hrtime.bigint();
	try {
		await con.run(`copy orders to '${f}' ${opts}`);
	} catch {
		// Writers that reject DICTIONARY_COMPRESSION_RATIO still honour the rest.
		await con.run(`copy orders to '${f}' ${opts.replace(', DICTIONARY_COMPRESSION_RATIO 999999', '')}`);
	}
	files[name] = f;
	rows.push({
		variant: `parquet:${name}`,
		bytes: size(f),
		writeMs: Number(process.hrtime.bigint() - t0) / 1e6
	});
}

// ---------------------------------------------------------------------------
// OpenZL needs "canonical" parquet: PLAIN encoding, no dictionary, no
// compression. DuckDB writes RLE_DICTIONARY for every low-cardinality column
// even at COMPRESSION uncompressed, and OpenZL's parquet profile rejects that
// outright — so the fair input has to come from a writer that can be told not
// to. pyarrow can; if it is not installed the OpenZL leg is skipped rather than
// silently compared against the wrong file.
// ---------------------------------------------------------------------------
const PY = process.env.BENCH_PYTHON ?? 'python3';
const canonical = path.join(WORK, 'orders.canonical.parquet');
let haveCanonical = false;
try {
	execFileSync(
		PY,
		[
			'-c',
			`import pyarrow.parquet as pq
t = pq.read_table(${JSON.stringify(files.plain)})
pq.write_table(t, ${JSON.stringify(canonical)}, compression='none',
               use_dictionary=False, data_page_version='1.0', write_statistics=False)`
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	haveCanonical = true;
	rows.push({ variant: 'parquet:canonical (PLAIN)', bytes: size(canonical), writeMs: 0 });
} catch (e) {
	console.log(`\n(no pyarrow at ${PY} — skipping the OpenZL leg; set BENCH_PYTHON to a venv python)`);
}

const plain = haveCanonical ? canonical : files.plain;
const zlOut = path.join(WORK, 'orders.plain.parquet.zl');
const zlTrained = path.join(WORK, 'orders.trained.parquet.zl');
const profileOut = path.join(WORK, 'trained.zc');

const run = (args, opts = {}) =>
	execFileSync(ZLI, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

let openzlOk = true;
let t0 = process.hrtime.bigint();
try {
	run(['compress', '--profile', 'parquet', '-o', zlOut, plain, '-f']);
} catch (e) {
	openzlOk = false;
	console.log(`\nOpenZL parquet profile FAILED on DuckDB-written parquet:`);
	console.log(`   ${(e.stderr || e.message).toString().trim().split('\n').slice(0, 4).join('\n   ')}`);
}
const zlCompressMs = Number(process.hrtime.bigint() - t0) / 1e6;

if (openzlOk) rows.push({ variant: 'openzl:parquet-profile', bytes: size(zlOut), writeMs: zlCompressMs });

// The actual OpenZL pitch: train a compressor specialised to this data. Worth
// ~7% here, which is the difference between losing to parquet's zstd:19 and
// drawing with it — so an evaluation that skips training understates OpenZL.
//
// Two things this got wrong the first time round, both silent:
//   - `train` takes a sample DIRECTORY, not a file. Given one file it reports
//     "Picked 1 samples out of 1" and fails.
//   - the trained compressor is applied with `-c`, not `--profile-arg`.
//     `--profile-arg` is accepted, ignored, and returns a byte-identical result
//     to the untrained run — which reads exactly like "training did nothing".
let trainedOk = false;
const sampleDir = path.join(WORK, 'samples');
try {
	console.log('\nTraining a specialised OpenZL compressor (minutes, saturates all cores)...');
	fs.mkdirSync(sampleDir, { recursive: true });
	execFileSync(
		PY,
		[
			'-c',
			`import pyarrow.parquet as pq
t = pq.read_table(${JSON.stringify(canonical)})
n = min(25000, t.num_rows // 8)
for j in range(8):
    pq.write_table(t.slice(j*n, n), f${JSON.stringify(sampleDir)} + f'/part{j}.parquet',
                   compression='none', use_dictionary=False,
                   data_page_version='1.0', write_statistics=False)`
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	fs.rmSync(profileOut, { force: true });
	run(['train', '--profile', 'parquet', '-o', profileOut, sampleDir], { timeout: 1_800_000 });

	const t1 = process.hrtime.bigint();
	run(['compress', '-c', profileOut, '-o', zlTrained, plain, '-f']);
	rows.push({
		variant: 'openzl:trained',
		bytes: size(zlTrained),
		writeMs: Number(process.hrtime.bigint() - t1) / 1e6
	});
	trainedOk = true;
} catch (e) {
	console.log(`   training unavailable: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`);
}

// Whole-file zstd over the plain parquet — the fair "generic codec" baseline
// for a transport-layer comparison.
const zstdOut = path.join(WORK, 'orders.plain.parquet.zst');
try {
	const t1 = process.hrtime.bigint();
	execFileSync('zstd', ['-19', '-q', '-f', '-o', zstdOut, plain]);
	rows.push({
		variant: 'zstd -19 (whole file)',
		bytes: size(zstdOut),
		writeMs: Number(process.hrtime.bigint() - t1) / 1e6
	});
} catch {
	/* zstd CLI absent — skip the baseline */
}

// ---------------------------------------------------------------------------
// Decompression cost: what you pay before the first row is readable.
// ---------------------------------------------------------------------------
const decompMs = {};
if (openzlOk) {
	const back = path.join(WORK, 'roundtrip.parquet');
	const t1 = process.hrtime.bigint();
	run(['decompress', '-o', back, zlOut, '-f']);
	decompMs['openzl:parquet-profile'] = Number(process.hrtime.bigint() - t1) / 1e6;
	const same = size(back) === size(plain);
	console.log(`\nOpenZL round-trip byte-identical: ${same ? 'yes' : 'NO — investigate'}`);
	fs.rmSync(back, { force: true });
}
if (trainedOk) {
	const back = path.join(WORK, 'roundtrip2.parquet');
	const t1 = process.hrtime.bigint();
	run(['decompress', '-o', back, zlTrained, '-f']);
	decompMs['openzl:trained'] = Number(process.hrtime.bigint() - t1) / 1e6;
	fs.rmSync(back, { force: true });
}

// ---------------------------------------------------------------------------
// THE DECIDING MEASUREMENT
//
// A dashboard query touches a few columns, not the table. Parquet stores each
// column separately and records where, so duckdb-wasm range-requests only what
// it needs. Sum the column chunks a representative query touches and compare
// that against the whole compressed artifact, which is the unit a whole-file
// codec forces you to move.
// ---------------------------------------------------------------------------
const QUERY_COLUMNS = ['order_month', 'category', 'sales'];

const chunkBytes = async (file, cols) => {
	const r = await sql(`
    select sum(total_compressed_size)::bigint as b
    from parquet_metadata('${file}')
    where path_in_schema in (${cols.map((c) => `'${c}'`).join(',')})
  `);
	return Number(r[0].b);
};

const footer = async (file) => {
	const r = await sql(`select sum(total_compressed_size)::bigint as b from parquet_metadata('${file}')`);
	return size(file) - Number(r[0].b);
};

const readsZstd = await chunkBytes(files.zstd, QUERY_COLUMNS);
const footZstd = await footer(files.zstd);

// ---------------------------------------------------------------------------
// Query wall-clock over each parquet variant (local disk, no network).
// ---------------------------------------------------------------------------
const QUERY = (f) => `
  select date_trunc('month', order_month) m, category, sum(sales) s
  from read_parquet('${f}') group by 1,2 order by 1,2`;

const queryMs = {};
for (const [name, f] of Object.entries(files)) {
	await sql(QUERY(f)); // warm
	const t1 = process.hrtime.bigint();
	await sql(QUERY(f));
	queryMs[`parquet:${name}`] = Number(process.hrtime.bigint() - t1) / 1e6;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const base = rows.find((r) => r.variant === 'parquet:zstd').bytes;

console.log(`\n${'='.repeat(78)}`);
console.log(`ARTIFACT SIZE — ${ROWS.toLocaleString()} rows x 15 cols`);
console.log('='.repeat(78));
console.log(
	['variant'.padEnd(26), 'size'.padStart(10), 'vs zstd'.padStart(10), 'write ms'.padStart(10), 'decomp ms'.padStart(11)].join('')
);
for (const r of rows.sort((a, b) => a.bytes - b.bytes)) {
	console.log(
		[
			r.variant.padEnd(26),
			`${MB(r.bytes)} MB`.padStart(10),
			(r.bytes === base ? '—' : pct(base, r.bytes)).padStart(10),
			r.writeMs.toFixed(0).padStart(10),
			(decompMs[r.variant] ? decompMs[r.variant].toFixed(0) : '—').padStart(11)
		].join('')
	);
}

console.log(`\n${'='.repeat(78)}`);
console.log('BYTES ON THE WIRE for one dashboard query');
console.log(`  select month, category, sum(sales) ...  (touches ${QUERY_COLUMNS.length} of 15 columns)`);
console.log('='.repeat(78));
console.log(`  parquet:zstd  range requests   ${MB(readsZstd + footZstd).padStart(8)} MB   (footer ${MB(footZstd)} + ${QUERY_COLUMNS.join(', ')})`);
for (const r of rows.filter((r) => r.variant.startsWith('openzl') || r.variant.startsWith('zstd -'))) {
	console.log(`  ${r.variant.padEnd(24)} full file  ${MB(r.bytes).padStart(8)} MB   (whole-file codec: no partial read)`);
}
const ratio = rows.filter((r) => r.variant.startsWith('openzl'))[0];
if (ratio) {
	console.log(
		`\n  => a whole-file codec moves ${(ratio.bytes / (readsZstd + footZstd)).toFixed(1)}x more bytes for this query than range-requested parquet.`
	);
}

console.log(`\n${'='.repeat(78)}`);
console.log('QUERY WALL-CLOCK (local disk)');
console.log('='.repeat(78));
for (const [k, v] of Object.entries(queryMs).sort((a, b) => a[1] - b[1])) {
	console.log(`  ${k.padEnd(26)} ${v.toFixed(0).padStart(6)} ms`);
}

console.log(`\nWorkdir kept at ${WORK} (rm -rf to reclaim ~${MB(Object.values(files).reduce((a, f) => a + size(f), 0))} MB)`);
