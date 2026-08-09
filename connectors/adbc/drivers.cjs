/**
 * Which ADBC driver serves each Evidence `flavor`, and how its options are spelled.
 *
 * Three of the seven flavors here are not separate drivers at all: DuckLake and
 * MotherDuck are DuckDB with, respectively, an extension and a `md:` path, and
 * they are listed as flavors because that is how a person thinks about them —
 * "I am connecting to MotherDuck", not "I am connecting to DuckDB, which will
 * then talk to MotherDuck". Collapsing them into `duckdb` would be accurate and
 * useless.
 *
 * Driver binaries are NOT bundled. Install them with:
 *     npx @columnar-tech/dbc install <driver>
 * which writes to the ADBC user driver path, where the driver manager finds them
 * by short name.
 */

/** Options every flavor accepts. */
const COMMON = {
	flavor: {
		title: 'Flavor',
		type: 'string',
		secret: false,
		required: true,
		description:
			'Which database: duckdb | ducklake | motherduck | postgresql | clickhouse | snowflake | bigquery',
		default: 'duckdb'
	},
	driver_path: {
		title: 'Driver path',
		type: 'string',
		secret: false,
		required: false,
		description:
			'Absolute path to the ADBC driver shared library. Only needed when the driver is not installed where the driver manager looks.'
	}
};

/**
 * @typedef {object} Flavor
 * @property {string} driver          short name passed to the ADBC driver manager
 * @property {string} label
 * @property {(opts: Record<string, any>, directory: string) => Record<string, string>} databaseOptions
 * @property {string[]} [requires]    option keys without which the connection cannot be attempted
 * @property {string} [note]
 */

const path = require('path');

/** @type {Record<string, Flavor>} */
const FLAVORS = {
	duckdb: {
		driver: 'duckdb',
		label: 'DuckDB',
		requires: [],
		databaseOptions: (o, directory) => ({
			// A relative filename is relative to the SOURCE directory, matching the
			// built-in duckdb connector — otherwise the same connection.yaml would
			// mean different files depending on where the CLI was invoked.
			path: o.filename
				? path.isAbsolute(o.filename)
					? o.filename
					: path.join(directory, o.filename)
				: ':memory:'
		})
	},

	ducklake: {
		driver: 'duckdb',
		label: 'DuckLake',
		note: 'DuckDB with the ducklake extension; `catalog` is the catalog database, `data_path` the storage location.',
		requires: [],
		databaseOptions: () => ({ path: ':memory:' })
	},

	motherduck: {
		driver: 'duckdb',
		label: 'MotherDuck',
		requires: ['token'],
		databaseOptions: (o) => ({
			// motherduck_token travels in the path so the driver hands it to the
			// extension at attach time; there is no separate option for it.
			path: `md:${o.database ?? ''}?motherduck_token=${o.token ?? ''}`
		})
	},

	postgresql: {
		driver: 'postgresql',
		label: 'PostgreSQL',
		requires: [],
		databaseOptions: (o) => ({
			uri:
				o.uri ??
				`postgresql://${encodeURIComponent(o.user ?? '')}:${encodeURIComponent(
					o.password ?? ''
				)}@${o.host ?? 'localhost'}:${o.port ?? 5432}/${o.database ?? ''}`
		})
	},

	clickhouse: {
		driver: 'clickhouse',
		label: 'ClickHouse',
		requires: [],
		// Three things about this driver are easy to get wrong, and each fails
		// with an error that does not point at the cause:
		//   - it speaks ClickHouse's HTTP interface (8123), not the native
		//     protocol (9000). Pointing it at 9000 gives "network error (Connect)".
		//   - credentials must be separate options. Embedded in the URI they are
		//     ignored and ClickHouse answers "Code: 194 Authentication failed".
		//   - the database must NOT be a URI path: /foo is read as an HTTP
		//     handler name, giving "There is no handle /foo".
		databaseOptions: (o) => {
			const scheme = o.ssl ? 'https' : 'http';
			const base = o.uri ?? `${scheme}://${o.host ?? 'localhost'}:${o.port ?? 8123}`;
			const uri = o.database && !/[?&]database=/.test(base)
				? `${base.replace(/\/+$/, '')}/?database=${encodeURIComponent(o.database)}`
				: base;

			const opts = { uri };
			const user = o.username ?? o.user;
			if (user) opts.username = user;
			if (o.password) opts.password = o.password;
			return opts;
		}
	},

	snowflake: {
		driver: 'snowflake',
		label: 'Snowflake',
		requires: ['account', 'username'],
		databaseOptions: (o) => {
			const opts = {
				'adbc.snowflake.sql.account': o.account,
				username: o.username,
				'adbc.snowflake.sql.auth_type': o.auth_type ?? 'auth_snowflake'
			};
			if (o.password) opts.password = o.password;
			if (o.database) opts['adbc.snowflake.sql.db'] = o.database;
			if (o.schema) opts['adbc.snowflake.sql.schema'] = o.schema;
			if (o.warehouse) opts['adbc.snowflake.sql.warehouse'] = o.warehouse;
			if (o.role) opts['adbc.snowflake.sql.role'] = o.role;
			if (o.private_key) {
				opts['adbc.snowflake.sql.client_option.jwt_private_key'] = o.private_key;
				opts['adbc.snowflake.sql.auth_type'] = o.auth_type ?? 'auth_jwt';
			}
			return opts;
		}
	},

	bigquery: {
		driver: 'bigquery',
		label: 'BigQuery',
		requires: ['project_id'],
		databaseOptions: (o) => {
			const opts = { 'adbc.bigquery.sql.project_id': o.project_id };
			if (o.dataset_id) opts['adbc.bigquery.sql.dataset_id'] = o.dataset_id;
			if (o.keyfile) {
				opts['adbc.bigquery.sql.auth_type'] = 'adbc.bigquery.sql.auth_type.json_credential_file';
				opts['adbc.bigquery.sql.auth_credentials'] = o.keyfile;
			} else {
				// Application Default Credentials — `gcloud auth application-default login`.
				// The value really is `...auth_type.auth_bigquery`; the intuitive
				// `...auth_type.default` is rejected outright by the driver.
				opts['adbc.bigquery.sql.auth_type'] = 'adbc.bigquery.sql.auth_type.auth_bigquery';
			}
			return opts;
		}
	}
};

/**
 * SQL run once, immediately after connecting. This is where the flavors that are
 * really DuckDB become themselves.
 *
 * @returns {string[]}
 */
const initSql = (flavor, o, directory) => {
	if (flavor === 'ducklake') {
		const catalog = o.catalog
			? path.isAbsolute(o.catalog)
				? o.catalog
				: path.join(directory, o.catalog)
			: path.join(directory, 'ducklake_catalog.ducklake');
		const dataPath = o.data_path
			? path.isAbsolute(o.data_path)
				? o.data_path
				: path.join(directory, o.data_path)
			: path.join(directory, 'ducklake_files');
		const name = o.attach_as ?? 'ducklake';
		return [
			`install ducklake`,
			`load ducklake`,
			`attach if not exists 'ducklake:${catalog}' as ${name} (data_path '${dataPath}/')`,
			`use ${name}`
		];
	}
	if (flavor === 'duckdb' && o.extensions) {
		return String(o.extensions)
			.split(',')
			.map((e) => e.trim())
			.filter(Boolean)
			.flatMap((e) => [`install ${e}`, `load ${e}`]);
	}
	return [];
};

module.exports = { FLAVORS, COMMON, initSql };
