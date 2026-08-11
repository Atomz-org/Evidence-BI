/**
 * Boot DuckDB-WASM in node against this project's built parquet, so the noodle
 * compiler can be tested by *running* the SQL it generates rather than by
 * matching strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, '.evidence/template');

export const boot = async () => {
	const duck = await import(
		path.join(ROOT, 'node_modules/@evidence-dev/universal-sql/src/client-duckdb/node.js')
	);

	await duck.initDB();

	const manifest = JSON.parse(
		fs.readFileSync(path.join(TEMPLATE, 'static/data/manifest.json'), 'utf8')
	);

	// Manifest paths are relative to the template directory.
	const absolute = Object.fromEntries(
		Object.entries(manifest.renderedFiles).map(([source, files]) => [
			source,
			files.map((f) => path.join(TEMPLATE, f))
		])
	);

	await duck.setParquetURLs(absolute);

	/** @param {string} sql */
	const run = async (sql) => {
		const rows = await duck.query(sql);
		return JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
	};

	return { run, sources: Object.keys(manifest.renderedFiles) };
};
