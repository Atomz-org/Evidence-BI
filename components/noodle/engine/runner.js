/**
 * One specification, two backends.
 *
 * A spec compiles either to SQL that DuckDB-WASM runs in the browser, or to a
 * Cube query that the semantic layer resolves. Everything downstream — table
 * calculations, the chart encoder, the exported markdown — reads the same
 * `{ rows, columns }`, so the difference is confined to this file.
 *
 * It lives apart from the components because there are now two surfaces running
 * specs: the noodle worksheet and every tile on a dashboard. A second copy of
 * this logic is how the two would quietly diverge on the things that are easy to
 * get subtly wrong — BigInt coercion, stale-result cancellation, which field
 * means "there is something to run".
 */

import { compile } from './compile.js';
import { compileCubeQuery, normalizeCubeResult } from './cube.js';
import { applyTableCalcs } from './tablecalc.js';

/**
 * Whether a compiled spec has anything to run.
 *
 * The two backends answer with different fields: DuckDB produces `sql`, Cube
 * produces a REST `query` and never produces SQL at all. Gating a UI on `sql`
 * alone leaves the Cube surface showing its empty state with the data loaded
 * behind it — which is exactly what it did before this was named.
 */
export const hasView = (compiled, cube) => (cube ? !!compiled?.query : !!compiled?.sql);

/** Compile a spec for whichever backend is configured. */
export const compileFor = (catalog, spec, cube) =>
	cube ? compileCubeQuery(catalog, spec) : compile(catalog, spec);

/**
 * DuckDB-WASM returns BigInt for 64-bit integers and Arrow-backed row proxies.
 * Neither survives structured cloning into a chart library, and a BigInt throws
 * the moment anything tries to serialise it.
 */
const plain = (rows) => JSON.parse(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));

let duckdb = null;
const duckdbQuery = async (sql) => {
	duckdb ??= await import('@evidence-dev/universal-sql/client-duckdb');
	return duckdb.query(sql);
};

/**
 * Compile a spec and run it.
 *
 * @param {object} args
 * @param {object} args.catalog
 * @param {object} args.spec
 * @param {object} [args.cube] Cube configuration; absent means DuckDB
 * @param {object} [args.cubeClient] required when `cube` is set
 * @param {(sql: string) => Promise<any[]>} [args.query] override the SQL runner (tests)
 * @returns {Promise<{ compiled: object, rows: object[], columns: object[], empty: boolean }>}
 */
export const runSpec = async ({ catalog, spec, cube = null, cubeClient = null, query = null }) => {
	const compiled = compileFor(catalog, spec, cube);

	if (!hasView(compiled, cube)) {
		return { compiled, rows: [], columns: [], empty: true };
	}

	let result;
	if (cube) {
		if (!cubeClient) throw new Error('A Cube client is required to run a Cube query.');
		result = normalizeCubeResult(await cubeClient.load(compiled.query), compiled.columns).rows;
	} else {
		result = plain(await (query ?? duckdbQuery)(compiled.sql));
	}

	const calculated = applyTableCalcs(result, compiled.columns);
	return { compiled, rows: calculated.rows, columns: calculated.columns, empty: false };
};

/**
 * A run guarded against out-of-order completion.
 *
 * Every keystroke on a shelf starts a query. They finish in whatever order the
 * warehouse feels like, so without a token the chart can settle on the result of
 * an edit two changes ago — rare, silent, and indistinguishable from a bug in the
 * compiler when it happens.
 */
export const createSequencer = () => {
	let token = 0;
	return {
		/** @param {() => Promise<T>} work @returns {Promise<T|null>} null if superseded */
		run: async (work) => {
			const mine = ++token;
			try {
				const value = await work();
				return mine === token ? value : null;
			} catch (e) {
				// A superseded run's failure is not the current view's failure. Report
				// it and the surface shows an error for a query nobody is waiting on.
				if (mine !== token) return null;
				throw e;
			}
		},
		get current() {
			return token;
		}
	};
};
