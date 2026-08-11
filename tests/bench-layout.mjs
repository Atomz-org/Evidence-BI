/**
 * How to actually make Evidence queries read less data.
 *
 * The tempting lever is the codec — swap zstd for something cleverer and the
 * file gets smaller. The measurements in docs/openzl-evaluation.md put the
 * ceiling on that at about 12%.
 *
 * The lever that matters is *layout*. Parquet records min/max statistics per
 * row group, so a reader can skip whole row groups whose range cannot satisfy
 * the filter. Whether that works at all depends on how the rows were ordered
 * when the file was written — which is a one-line decision at write time and is
 * usually left to chance.
 *
 * This measures both, side by side, so the comparison is not an argument.
 *
 * Run:  node tests/bench-layout.mjs [--rows 2000000]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
	const i = process.argv.indexOf(`--${n}`);
	return i === -1 ? d : process.argv[i + 1];
};
const ROWS = Number(arg('rows', 2_000_000));
const WORK = path.join(ROOT, '.bench');
fs.mkdirSync(WORK, { recursive: true });

const db = await DuckDBInstance.create(':memory:');
const con = await db.connect();
const q = async (s) => (await con.run(s)).getRowObjects();
const one = async (s) => Number((await q(s))[0].b);

await q('select setseed(0.42)');
await q(`
  create table o as
  select row_number() over (order by ts) id, ts order_datetime, date_trunc('month', ts) order_month,
    'user' || cast(random()*250000 as int) || '@example.com' email,
    cast(random()*9000 as int) || ' Main St' address,
    ['CA','NY','TX','FL','IL','WA','MA','GA'][cast(random()*8 as int)+1] state,
    ['Handcart','Lantern','Rope','Satchel','Tinderbox','Whetstone'][cast(random()*6 as int)+1] item,
    ['Tools','Light','Storage','Sundry'][cast(random()*4 as int)+1] category,
    round(5 + random()*400, 2) sales,
    ['Email','Social','Search','Direct','Affiliate'][cast(random()*5 as int)+1] channel
  from (select timestamp '2023-01-01' + interval (cast(random()*1051200 as int)) minute ts
        from range(${ROWS})) t
`);

const LAYOUTS = {
	'as-is (insertion order)': 'select * from o',
	'sorted by month': 'select * from o order by order_month',
	'clustered: category, month': 'select * from o order by category, order_month',
	'clustered: month, category': 'select * from o order by order_month, category'
};

// The query the dashboard actually runs: one category, three columns.
const COLS = "('order_month','category','sales')";
const FILTER_COL = 'category';
const FILTER_VAL = 'Tools';

console.log(`${ROWS.toLocaleString()} rows, ROW_GROUP_SIZE 100000, zstd level 6\n`);
console.log(
	['layout'.padEnd(28), 'file MB'.padStart(9), 'RGs'.padStart(5), 'hit'.padStart(5), 'bytes read'.padStart(12), 'vs worst'.padStart(9)].join('')
);

const results = [];
for (const [name, select] of Object.entries(LAYOUTS)) {
	const f = path.join(WORK, 'layout.parquet');
	fs.rmSync(f, { force: true });
	await q(`copy (${select}) to '${f}' (FORMAT 'PARQUET', CODEC 'ZSTD', COMPRESSION_LEVEL 6, ROW_GROUP_SIZE 100000)`);

	const total = fs.statSync(f).size;
	const groups = Number((await q(`select count(distinct row_group_id) b from parquet_metadata('${f}')`))[0].b);

	// Row groups whose [min,max] for the filter column could contain the value.
	// This is exactly the test a parquet reader applies before fetching a chunk.
	const surviving = `
    select row_group_id from parquet_metadata('${f}')
    where path_in_schema = '${FILTER_COL}'
      and stats_min <= '${FILTER_VAL}' and stats_max >= '${FILTER_VAL}'`;
	const hit = Number((await q(`select count(*) b from (${surviving})`))[0].b);

	const bytes = await one(`
    select sum(total_compressed_size)::bigint b from parquet_metadata('${f}')
    where path_in_schema in ${COLS} and row_group_id in (${surviving})`);

	results.push({ name, total, groups, hit, bytes });
}

const worst = Math.max(...results.map((r) => r.bytes));
for (const r of results) {
	console.log(
		[
			r.name.padEnd(28),
			(r.total / 1e6).toFixed(2).padStart(9),
			String(r.groups).padStart(5),
			String(r.hit).padStart(5),
			`${(r.bytes / 1e6).toFixed(3)} MB`.padStart(12),
			`${(worst / r.bytes).toFixed(1)}x`.padStart(9)
		].join('')
	);
}

const best = results.reduce((a, b) => (a.bytes < b.bytes ? a : b));
console.log(
	`\nBest layout reads ${(worst / best.bytes).toFixed(1)}x less than the worst for "${FILTER_COL} = '${FILTER_VAL}'".`
);
console.log(
	`For comparison, the best codec swap measured in docs/openzl-evaluation.md is worth 1.12x.`
);
console.log(
	`\nThe tradeoff is real: clustering by ${FILTER_COL} de-clusters everything else, so a` +
		`\nmonth-window filter gets worse and the file gets larger (sorting one column` +
		`\nscrambles the locality the others had). Cluster by what you filter on most.`
);
