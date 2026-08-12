/**
 * Cube configuration for the server deployment.
 *
 * The container image (cubejs/cube:v1.7.17, used by cube/up.sh for local work)
 * boots in dev mode: playground, model file watcher, scaffolding API, and a
 * Cube Store process alongside the server. Together those cost roughly 1 GB.
 * This project's model is two cubes with twelve members and **no
 * pre-aggregations**, so Cube Store has nothing to store and the playground has
 * nobody to serve. Running the server natively drops the same functionality
 * into ~220 MB.
 *
 * Nothing about the model changes — `cube/model/cubes/*.yml` is loaded verbatim,
 * so the measures, joins and segments the pages resolve through are the same
 * ones cube/up.sh serves locally.
 */

const path = require('node:path');

// The model is the repo's, not a copy. A staged copy is what cube/up.sh has to
// do on macOS (the podman VM cannot read ~/Documents), and it is the reason
// that script tells you to re-run it after editing a model file. On a Linux
// server there is no such restriction and no reason to accept the drift.
const REPO = path.resolve(__dirname, '..', '..');

module.exports = {
	schemaPath: path.join(REPO, 'cube', 'model'),

	// The model's SQL is `read_parquet('/data/dbt_semantic/orders/orders.parquet')`
	// — an absolute path, because in the container /data is where the Evidence
	// parquet is mounted (cube/docker-compose.yml).
	//
	// Natively there is no mount, so install.sh creates the same absolute path
	// as a symlink:
	//
	//     /data -> /srv/evidence/current/data
	//
	// That is deliberate rather than lazy. Rewriting the paths here would fork
	// the model: cube/model/cubes/*.yml would mean one thing under cube/up.sh
	// locally and another on the server, and the whole point of the file is
	// that a measure is defined once. Making the server match the model costs
	// one symlink; making the model match the server costs a second source of
	// truth.
	//
	// It also means Cube reads whatever `current` points at, so the atomic
	// symlink flip at the end of deploy/build.sh moves Cube onto the new
	// parquet with no restart.
	driverFactory: () => ({
		type: 'duckdb',
		database: ':memory:'
	}),

	// Cube's own date logic, pinned. This is NOT the fix for month buckets
	// arriving an hour early over the SQL API — that is client-side, and
	// cube/README.md ("The timestamp trap") has it.
	scheduledRefreshTimer: false,

	// There is no orchestration to do without pre-aggregations. Left on, the
	// refresh scheduler wakes periodically to decide there is nothing to
	// refresh, holding a query queue and its buffers the whole time.
	orchestratorOptions: {
		queryCacheOptions: {
			// The dashboards are read-mostly over a fixture that changes once a
			// day. A small in-process cache is worth far more than Cube Store.
			refreshKeyRenewalThreshold: 300,
			backgroundRenew: false
		},
		preAggregationsOptions: {
			externalRefresh: false
		}
	},

	// A static site has no user to enforce against, so there is no security
	// context to derive — the same position rill/README.md takes about
	// `security:`. Cube is bound to loopback and reached only through Caddy's
	// /cubejs-api proxy, which is the actual control.
	//
	// `apiSecret` is not set here on purpose, even though Cube accepts it in
	// this file. This file is committed; the secret is a secret. Cube reads
	// CUBEJS_API_SECRET from the environment, which deploy/env supplies to
	// evidence-cube.service — see deploy/env.example for how to generate it.
	checkAuth: (req, auth) => {}
};
