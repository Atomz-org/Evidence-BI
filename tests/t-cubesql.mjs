/**
 * Every SQL statement noodle exports for a Cube-backed view must actually run on
 * Cube's SQL API — that is the whole point of the export, so it is executed
 * rather than eyeballed.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { createRequire } from 'node:module';

const require = createRequire(`${ROOT}/package.json`);
const postgres = require('pg');
const { Client } = postgres;

// Cube's SQL API returns a truncated month as `timestamp without time zone`
// ("2026-07-01 00:00:00"), and node-postgres parses that in the *machine's*
// timezone. On a UTC+2 box July becomes 2026-06-30T22:00:00Z — a whole month
// bucket landing in the previous month. The value Cube sent was correct; the
// client localised it. Read those columns as UTC.
//   1114 = timestamp without time zone
//   1082 = date
postgres.types.setTypeParser(1114, (v) => new Date(`${v.replace(' ', 'T')}Z`));
postgres.types.setTypeParser(1082, (v) => new Date(`${v}T00:00:00Z`));

const ENGINE = `${ROOT}/components/noodle/engine`;
const { catalogFromCubeMeta, createCubeClient, toCubeSql } = await import(`${ENGINE}/cube.js`);
const { emptySpec, dropField } = await import(`${ENGINE}/spec.js`);

const client = createCubeClient({ apiUrl: 'http://127.0.0.1:4000' });
const catalog = catalogFromCubeMeta(await client.meta());
const F = (id) => catalog.byId[id];

const build = (...steps) => steps.reduce((s, [field, shelf]) => dropField(s, catalog, F(field), shelf), emptySpec());

const cases = [
	['dimension x measure', build(['orders.region', 'columns'], ['orders.revenue', 'rows'])],
	['time grain', build(['orders.ordered_at', 'columns'], ['orders.revenue', 'rows'])],
	['cross-cube join', build(['customers.country_code', 'columns'], ['orders.revenue', 'rows'])],
	[
		'two measures + colour',
		build(
			['orders.region', 'columns'],
			['orders.revenue', 'rows'],
			['orders.count', 'rows'],
			['orders.order_status', 'color']
		)
	],
	[
		'segment + filter',
		{
			...build(['orders.region', 'columns'], ['orders.revenue', 'rows']),
			segments: ['orders.not_cancelled'],
			filters: [{ fieldId: 'orders.order_status', role: 'dimension', op: 'notIn', values: ['refunded'] }]
		}
	]
];

const pg = new Client({ host: '127.0.0.1', port: 15432, user: 'cube', password: 'cube', database: 'cube' });
await pg.connect();

let fails = 0;
for (const [name, spec] of cases) {
	const { sql } = toCubeSql(catalog, spec);
	if (!sql) {
		fails++;
		console.log(`FAIL  ${name} :: produced no SQL`);
		continue;
	}
	try {
		const result = await pg.query(sql);
		console.log(`ok    ${name} -> ${result.rows.length} rows ${JSON.stringify(result.rows[0] ?? {}).slice(0, 100)}`);
	} catch (e) {
		fails++;
		console.log(`FAIL  ${name} :: ${e.message}`);
		console.log(sql.split('\n').map((l) => `        ${l}`).join('\n'));
	}
}

// The exported SQL must agree with what the REST path returned for the same view.
const spec = cases[0][1];
const { sql } = toCubeSql(catalog, spec);
const viaSql = await pg.query(sql);
const viaRest = await client.load({ measures: ['orders.revenue'], dimensions: ['orders.region'] });
const restRows = viaRest.data ?? viaRest.results?.[0]?.data ?? [];
const restByRegion = Object.fromEntries(restRows.map((r) => [r['orders.region'], Number(r['orders.revenue'])]));
const agree = viaSql.rows.every((r) => Math.abs(Number(r.revenue) - restByRegion[r.region]) < 1e-6);
console.log(`${agree ? 'ok   ' : 'FAIL '} exported SQL agrees with the REST result`);
if (!agree) fails++;

await pg.end();
console.log(`\n${fails ? `${fails} failure(s)` : 'all generated Cube SQL executed and agreed'}`);
process.exit(fails ? 1 : 0);
