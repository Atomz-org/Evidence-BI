/**
 * Month buckets must not move when the machine's timezone does.
 *
 * Cube sends a granulated timestamp as "2026-07-01T00:00:00.000" — ISO-shaped,
 * no offset. ECMAScript reads an offset-less date-TIME as LOCAL time, so
 * `new Date(...)` shifts it by the machine's offset and July's revenue is filed
 * under June on any machine east of UTC. Totals stay correct, nothing throws,
 * and the chart is simply wrong — which is why this needs a test rather than
 * care.
 *
 * The asymmetry that hides it: a date-ONLY string ("2026-07-01") is specified as
 * UTC, so short dates look fine while granulated timestamps silently drift.
 *
 * Runs the same assertions under several timezones, east and west, since a bug
 * of this shape is invisible in UTC — where CI usually runs.
 *
 *   node tests/t-cube-tz.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZONES = ['UTC', 'Europe/Oslo', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'];

// Child mode: assert inside one timezone.
if (process.argv[2] === '--child') {
	const { normalizeCubeResult } = await import(`${ROOT}/components/noodle/engine/cube.js`);

	// Exactly the shape Cube 1.7 returns for a month granularity.
	const response = {
		data: [
			{ 'orders.ordered_at.month': '2026-07-01T00:00:00.000', 'orders.revenue': '204523.27' },
			{ 'orders.ordered_at.month': '2026-08-01T00:00:00.000', 'orders.revenue': '18070.97' }
		],
		annotation: { measures: { 'orders.revenue': {} }, timeDimensions: {} }
	};
	const columns = [
		{ alias: 'orders.ordered_at.month', dataType: 'date', role: 'dimension' },
		{ alias: 'orders.revenue', dataType: 'number', role: 'measure' }
	];

	const { rows } = normalizeCubeResult(response, columns);
	const first = rows[0]['orders.ordered_at.month'];

	const problems = [];
	if (!(first instanceof Date)) problems.push('not revived as a Date');
	if (first.getUTCFullYear() !== 2026) problems.push(`UTC year ${first.getUTCFullYear()}`);
	if (first.getUTCMonth() !== 6) problems.push(`UTC month ${first.getUTCMonth()} (want 6 = July)`);
	if (first.getUTCDate() !== 1) problems.push(`UTC day ${first.getUTCDate()}`);
	if (first.toISOString() !== '2026-07-01T00:00:00.000Z') problems.push(first.toISOString());
	if (typeof rows[0]['orders.revenue'] !== 'number') problems.push('measure not numeric');

	if (problems.length) {
		console.log(`FAIL ${process.env.TZ}: ${problems.join('; ')}`);
		process.exit(1);
	}
	console.log(`ok   ${String(process.env.TZ).padEnd(22)} -> ${first.toISOString()}`);
	process.exit(0);
}

let failed = 0;
for (const tz of ZONES) {
	const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
		env: { ...process.env, TZ: tz },
		encoding: 'utf8'
	});
	process.stdout.write(r.stdout || r.stderr);
	if (r.status !== 0) failed++;
}

console.log(`\n${ZONES.length - failed}/${ZONES.length} timezones agree`);
process.exit(failed ? 1 : 0);
