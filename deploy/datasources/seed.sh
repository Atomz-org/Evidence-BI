#!/usr/bin/env bash
#
# Seed the two ADBC fixtures from the project's own parquet.
#
# `sources/adbc_postgres` and `sources/adbc_clickhouse` exist to prove the ADBC
# connector reaches a real Postgres and a real ClickHouse — one connector, one
# Arrow schema, seven flavors (docs/adbc.md). That only means anything if the
# two servers hold the same orders the rest of the project does, so the fixture
# is derived from `.evidence/template/static/data`, never hand-maintained.
#
# Run once after install, and again whenever the marts change shape:
#
#   deploy/datasources/seed.sh
#
# Both servers must be running. deploy/build.sh starts and stops them around
# `evidence sources`; this script assumes you have started them yourself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PARQUET="$ROOT/.evidence/template/static/data/dbt_semantic/orders/orders.parquet"

PGHOST=127.0.0.1 PGPORT=15433 PGUSER=evidence PGPASSWORD=evidence PGDATABASE=evidence
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
CH_URL="${CH_URL:-http://127.0.0.1:8123}"
CH_AUTH="${CH_AUTH:-default:clickhouse}"

[ -f "$PARQUET" ] || { echo "no parquet at $PARQUET — run 'npm run sources' first" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- parquet -> CSV ---------------------------------------------------------
# DuckDB is already a dependency of this project; use whichever copy is present
# rather than asking the server to install another database.
echo "==> extracting fixture rows from parquet"
if command -v duckdb >/dev/null 2>&1; then
	duckdb -c "copy (select region, order_amount_usd as amount, ordered_at from read_parquet('$PARQUET')) to '$TMP/orders.csv' (header, delimiter ',')"
else
	node -e "
	const { DuckDBInstance } = await import('@duckdb/node-api').catch(() => ({}));
	if (!DuckDBInstance) { console.error('install duckdb CLI or @duckdb/node-api'); process.exit(1); }
	const db = await DuckDBInstance.create(':memory:');
	const c = await db.connect();
	await c.run(\"copy (select region, order_amount_usd as amount, ordered_at from read_parquet('$PARQUET')) to '$TMP/orders.csv' (header, delimiter ',')\");
	" --input-type=module
fi
ROWS=$(( $(wc -l < "$TMP/orders.csv") - 1 ))
echo "    $ROWS rows"

# --- PostgreSQL -------------------------------------------------------------
# The ADBC postgres query reads `region`, `ordered_at`; `amount` rides along so
# both fixtures come from one extract.
echo "==> postgres :15433"
psql -v ON_ERROR_STOP=1 -q <<-SQL
	create table if not exists orders (
	    region      text        not null,
	    amount      numeric(18,2),
	    ordered_at  timestamp
	);
	truncate orders;
SQL
psql -v ON_ERROR_STOP=1 -q -c "\copy orders (region, amount, ordered_at) from '$TMP/orders.csv' with (format csv, header true)"
psql -qtA -c 'select count(*) || '"'"' rows in postgres.orders'"'"' from orders'

# --- ClickHouse -------------------------------------------------------------
# HTTP interface on 8123 — the native protocol on 9000 is not what the driver
# speaks, and is switched off in clickhouse-low-memory.xml.
echo "==> clickhouse :8123"
ch() { curl -sS -u "$CH_AUTH" "$CH_URL" --data-binary "$1"; }

ch "create table if not exists default.orders (
        region     String,
        amount     Decimal(18,2),
        ordered_at DateTime64(3)
    ) engine = MergeTree order by region"
ch "truncate table default.orders"

# FORMAT CSVWithNames streams; the fixture is small but there is no reason to
# buffer it into a query string.
curl -sS -u "$CH_AUTH" \
	"$CH_URL/?query=insert%20into%20default.orders%20format%20CSVWithNames" \
	--data-binary "@$TMP/orders.csv" >/dev/null

ch "select concat(toString(count()), ' rows in clickhouse.default.orders') from default.orders"

echo
echo "seeded. verify the connector end-to-end with: npm run test:adbc"
