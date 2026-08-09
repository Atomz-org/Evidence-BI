/**
 * Arrow Database Connectivity as an Evidence source.
 *
 * One connector, seven flavors. Instead of a bespoke client per warehouse, every
 * database is reached through its ADBC driver, which returns Arrow — so the
 * column types come from a schema rather than from sniffing the first few rows.
 *
 *     # sources/warehouse/connection.yaml
 *     name: warehouse
 *     type: adbc
 *     options:
 *       flavor: clickhouse
 *       host: localhost
 *       port: 9000
 *
 * Driver binaries are not bundled — install the ones you need:
 *     npx @columnar-tech/dbc install clickhouse
 *
 * The driver manager is ESM-only and this plugin is CommonJS (Evidence's
 * connector contract), so it is reached through a dynamic import.
 */
const { EvidenceType, TypeFidelity, cleanQuery } = require('@evidence-dev/db-commons');
const { FLAVORS, COMMON, initSql } = require('./drivers.cjs');
const { tableToRows } = require('./arrow-types.cjs');

/** @type {Promise<any> | null} */
let driverManager = null;
const loadDriverManager = () => {
	if (!driverManager) driverManager = import('@apache-arrow/adbc-driver-manager');
	return driverManager;
};

/**
 * Resolve a connection.yaml into { driver, databaseOptions, init }.
 * Throws with an actionable message rather than letting the driver fail obscurely.
 */
const resolve = (opts, directory) => {
	const name = String(opts.flavor ?? 'duckdb').toLowerCase();
	const flavor = FLAVORS[name];
	if (!flavor) {
		throw new Error(
			`Unknown adbc flavor "${name}". Expected one of: ${Object.keys(FLAVORS).join(', ')}`
		);
	}

	const missing = (flavor.requires ?? []).filter((k) => !opts[k]);
	if (missing.length) {
		throw new Error(
			`${flavor.label} needs ${missing.map((m) => `\`${m}\``).join(', ')} in connection.yaml`
		);
	}

	return {
		driver: opts.driver_path || flavor.driver,
		databaseOptions: flavor.databaseOptions(opts, directory),
		init: initSql(name, opts, directory),
		label: flavor.label
	};
};

/**
 * Open a connection, run `fn`, and close both — even when `fn` throws.
 * ADBC handles are native resources; leaking them leaks memory in the CLI.
 */
/**
 * Two copies of libduckdb in one process corrupt each other.
 *
 * The ADBC DuckDB driver bundles its own libduckdb (1.5.x). Evidence embeds a
 * different one through `@duckdb/node-api` (1.4.x) and duckdb-wasm. Loaded
 * together they resolve each other's symbols, and the damage does not surface
 * until something touches the storage layer: `select 1` is fine, `select ... from
 * a_table` dies with "INTERNAL Error: Attempted to dereference unique_ptr that
 * is NULL" and a C++ stack trace with no mention of ADBC.
 *
 * Refusing up front, with the reason, beats a native crash that looks like data
 * corruption. Outside Evidence (scripts, notebooks, tests) there is no second
 * libduckdb and the flavor works normally — so the guard tests for the actual
 * conflict rather than banning the flavor.
 */
const DUCKDB_BACKED = new Set(['duckdb', 'ducklake', 'motherduck']);

const evidenceDuckdbLoaded = () =>
	Object.keys(require.cache ?? {}).some((f) =>
		/[/\\]@duckdb[/\\]node-(api|bindings)[/\\]/.test(f)
	);

const assertNoDuckdbConflict = (flavorName) => {
	if (!DUCKDB_BACKED.has(flavorName)) return;
	if (!evidenceDuckdbLoaded()) return;
	if (process.env.ADBC_ALLOW_DUCKDB_CONFLICT) return;

	throw new Error(
		`The adbc "${flavorName}" flavor cannot run in this process: @duckdb/node-api is already ` +
			`loaded, and two copies of libduckdb corrupt each other (the failure looks like ` +
			`"dereference unique_ptr that is NULL" on the first table scan).\n` +
			`\tInside Evidence, use the built-in \`type: duckdb\` or \`type: motherduck\` connector instead — ` +
			`Evidence embeds DuckDB already, so ADBC adds nothing here.\n` +
			`\tADBC is worth it for databases Evidence reaches over the network: postgresql, clickhouse, ` +
			`snowflake, bigquery.\n` +
			`\tSet ADBC_ALLOW_DUCKDB_CONFLICT=1 to override (expect the crash).`
	);
};

const withConnection = async (opts, directory, fn) => {
	const { AdbcDatabase } = await loadDriverManager();
	const { driver, databaseOptions, init } = resolve(opts, directory);
	assertNoDuckdbConflict(String(opts.flavor ?? 'duckdb').toLowerCase());

	const db = new AdbcDatabase({ driver, databaseOptions });
	let connection;
	try {
		connection = await db.connect();
		for (const statement of init) {
			await connection.execute(statement);
		}
		return await fn(connection);
	} finally {
		await connection?.close().catch(() => {});
		await db.close().catch(() => {});
	}
};

/**
 * @param {string} queryString
 * @param {Record<string, any>} options
 * @returns {Promise<{ rows: Record<string, unknown>[], columnTypes: any[], expectedRowCount: number }>}
 */
const runQuery = async (queryString, options = {}) => {
	const { directory = '.', ...opts } = options;
	const sql = cleanQuery(queryString);

	return withConnection(opts, directory, async (connection) => {
		const table = await connection.query(sql);
		const { rows, columnTypes } = tableToRows(table);
		return { rows, columnTypes, expectedRowCount: rows.length };
	});
};

module.exports = runQuery;

/** @type {import("@evidence-dev/db-commons").GetRunner<Record<string, any>>} */
module.exports.getRunner = async (opts, directory) => {
	// Fail loudly at load time rather than once per query file.
	resolve(opts, directory);

	return async (queryContent, queryPath) => {
		if (!queryPath.endsWith('.sql')) return null;
		if (queryPath.endsWith('initialize.sql')) return null;
		return runQuery(queryContent, { ...opts, directory });
	};
};

/** @type {import("@evidence-dev/db-commons").ConnectionTester<Record<string, any>>} */
module.exports.testConnection = async (opts, directory) => {
	try {
		await runQuery('select 1 as connection_test', { ...opts, directory });
		return true;
	} catch (e) {
		const message = e?.message ?? String(e);

		// A missing driver is the most common failure and the driver manager's
		// error for it does not say what to do. The match has to be narrow:
		// BigQuery answers "could not find default credentials", which is the
		// opposite situation — the driver loaded fine — and telling someone to
		// reinstall it would send them the wrong way entirely.
		const driverMissing =
			/(could not (find|load)|failed to (open|load)|no such file|not found)[^.]*\b(driver|librar|manifest|\.so\b|\.dylib\b|\.dll\b)/i.test(
				message
			) || /^\s*(could not find|failed to load) driver/i.test(message);

		if (driverMissing) {
			const flavor = FLAVORS[String(opts.flavor ?? 'duckdb').toLowerCase()];
			return {
				reason:
					`${message}\n\tInstall the driver:  npx @columnar-tech/dbc install ${flavor?.driver ?? opts.flavor}` +
					`\n\tor set \`driver_path\` to the shared library.`
			};
		}
		return { reason: message };
	}
};

module.exports.options = {
	...COMMON,

	// duckdb / ducklake
	filename: {
		title: 'Filename',
		type: 'string',
		secret: false,
		required: false,
		description: 'duckdb: database file, relative to the source directory. Omit for :memory:.'
	},
	extensions: {
		title: 'Extensions',
		type: 'string',
		secret: false,
		required: false,
		description: 'duckdb: comma-separated extensions to install and load.'
	},
	catalog: {
		title: 'Catalog',
		type: 'string',
		secret: false,
		required: false,
		description: 'ducklake: catalog database path.'
	},
	data_path: {
		title: 'Data path',
		type: 'string',
		secret: false,
		required: false,
		description: 'ducklake: where table data is written.'
	},
	attach_as: {
		title: 'Attach as',
		type: 'string',
		secret: false,
		required: false,
		description: 'ducklake: schema name to attach the lake under. Defaults to `ducklake`.'
	},

	// motherduck
	token: {
		title: 'Token',
		type: 'string',
		secret: true,
		required: false,
		description: 'motherduck: service token.'
	},

	// network databases
	host: { title: 'Host', type: 'string', secret: false, required: false },
	port: { title: 'Port', type: 'number', secret: false, required: false },
	database: { title: 'Database', type: 'string', secret: false, required: false },
	schema: { title: 'Schema', type: 'string', secret: false, required: false },
	user: { title: 'User', type: 'string', secret: false, required: false },
	username: {
		title: 'Username',
		type: 'string',
		secret: false,
		required: false,
		description: 'snowflake uses `username`; postgres/clickhouse use `user`.'
	},
	password: { title: 'Password', type: 'string', secret: true, required: false },
	uri: {
		title: 'URI',
		type: 'string',
		secret: true,
		required: false,
		description: 'postgresql: full connection URI, used instead of host/port/user/password.'
	},
	endpoint: {
		title: 'Endpoint',
		type: 'string',
		secret: false,
		required: false,
		description: 'clickhouse: host:port, used instead of host/port.'
	},
	ssl: { title: 'SSL', type: 'boolean', secret: false, required: false },

	// snowflake
	account: { title: 'Account', type: 'string', secret: false, required: false },
	warehouse: { title: 'Warehouse', type: 'string', secret: false, required: false },
	role: { title: 'Role', type: 'string', secret: false, required: false },
	auth_type: { title: 'Auth type', type: 'string', secret: false, required: false },
	private_key: { title: 'Private key', type: 'string', secret: true, required: false },

	// bigquery
	project_id: { title: 'Project ID', type: 'string', secret: false, required: false },
	dataset_id: { title: 'Dataset ID', type: 'string', secret: false, required: false },
	keyfile: {
		title: 'Service account keyfile',
		type: 'string',
		secret: true,
		required: false,
		description: 'bigquery: path to a JSON credential file. Omit to use Application Default Credentials.'
	}
};

module.exports.FLAVORS = FLAVORS;
