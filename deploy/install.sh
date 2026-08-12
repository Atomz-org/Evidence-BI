#!/usr/bin/env bash
#
# Provision a fresh 2 GB Debian/Ubuntu box for Evidence BI.
#
# Everything runs on this machine. No managed database, no object store, no
# hosted semantic layer, no CDN — the site is static files on local disk, every
# query runs in the reader's browser on duckdb-wasm, and the only always-on
# service besides the web server is Cube on loopback.
#
#   sudo deploy/install.sh
#
# Read deploy/README.md first: it has the measured memory budget and explains
# why the build is sequenced the way it is.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

SERVE_ROOT="${SERVE_ROOT:-/srv/evidence}"
APP="$SERVE_ROOT/app"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. the pressure valve, before anything else ----------------------------
# Installing node_modules alone will page on a box this size.
log "memory: zram + swapfile"
"$HERE/zram-setup.sh"

# --- 2. packages ------------------------------------------------------------
log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# brotli: deploy/precompress.sh, so the server never compresses at request time
# curl/gnupg: the repo keys below
apt-get install -y -qq curl ca-certificates gnupg brotli git rsync

if ! command -v node >/dev/null 2>&1; then
	log "node ${NODE_MAJOR}.x"
	mkdir -p /etc/apt/keyrings
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
		| gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
	echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
		> /etc/apt/sources.list.d/nodesource.list
	apt-get update -qq
	apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
	log "caddy"
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy
fi

# --- 3. the ADBC fixtures ---------------------------------------------------
# These exist so the ADBC connector is exercised against a real Postgres and a
# real ClickHouse (docs/adbc.md). They are build-time only: deploy/build.sh
# starts them for the seconds `evidence sources` needs and stops them again, so
# they are installed but NOT enabled at boot.
log "ADBC fixtures (postgres, clickhouse) — build-time only"
apt-get install -y -qq postgresql postgresql-client

if ! command -v clickhouse >/dev/null 2>&1; then
	curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
		| gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg 2>/dev/null || true
	echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg] https://packages.clickhouse.com/deb stable main" \
		> /etc/apt/sources.list.d/clickhouse.list
	apt-get update -qq
	apt-get install -y -qq clickhouse-server clickhouse-client
fi

log "sizing the fixtures down"
PG_CONFDIR="$(find /etc/postgresql -maxdepth 3 -type d -name conf.d 2>/dev/null | head -1)"
[ -n "$PG_CONFDIR" ] && install -m 644 "$HERE/datasources/postgres-low-memory.conf" "$PG_CONFDIR/"
install -d /etc/clickhouse-server/config.d
install -m 644 "$HERE/datasources/clickhouse-low-memory.xml" /etc/clickhouse-server/config.d/

# Off at boot. They cost ~390 MB together and are needed for seconds a day.
systemctl disable --now postgresql clickhouse-server >/dev/null 2>&1 || true

# --- 4. user and layout -----------------------------------------------------
log "user and layout"
id -u evidence >/dev/null 2>&1 || useradd --system --home "$SERVE_ROOT" --shell /usr/sbin/nologin evidence
mkdir -p "$SERVE_ROOT/releases" "$APP"

if [ "$ROOT" != "$APP" ]; then
	rsync -a --delete \
		--exclude node_modules --exclude build --exclude .git \
		--exclude vendor --exclude .evidence/template \
		"$ROOT/" "$APP/"

	# vendor/ is 527 MB of git submodules (the Evidence, Cube and DuckDB
	# sources) and almost none of it is needed here — but it is NOT optional.
	# `npm ci` runs postinstall, which runs scripts/apply-notebook-core.mjs,
	# which copies two payloads out of the vendored monorepo into node_modules:
	#
	#   packages/evidence/{cli.js,notebook}       .ipynb as a native page format
	#   packages/lib/universal-sql/src/...        parquet at zstd 6, not 3
	#
	# Drop the whole directory and both features go quietly missing — the
	# notebook page stops compiling and parquet gets larger. So ship the sliver
	# postinstall reads (~292 KB) and leave the other 527 MB at home.
	rsync -a --relative \
		"$ROOT/./vendor/evidence/packages/evidence" \
		"$ROOT/./vendor/evidence/packages/lib/universal-sql" \
		"$APP/"
fi
chown -R evidence:evidence "$SERVE_ROOT"

[ -f "$HERE/env" ] || install -m 644 -o evidence -g evidence "$HERE/env.example" "$APP/deploy/env"

# --- 5. application dependencies -------------------------------------------
# vendor/ is 527 MB of git submodules — the Evidence, Cube and DuckDB sources.
# They are how the notebook patch is developed (scripts/apply-notebook-core.mjs
# installs it from vendor/evidence). The server does not need them: the patch
# is applied to node_modules at postinstall, and what is committed under
# components/ and .evidence/ is the result. rsync above skips them.
log "npm ci  (this is the slowest step)"
sudo -u evidence env NODE_OPTIONS=--max-old-space-size=1024 \
	npm --prefix "$APP" ci --omit=dev --no-audit --no-fund

# Cube, natively. The cubejs/cube image boots dev mode + Cube Store (~1 GB);
# this model has no pre-aggregations, so the server alone is the whole feature.
log "cube (native, no container)"
sudo -u evidence npm --prefix "$APP/deploy/cube" install --no-audit --no-fund \
	@cubejs-backend/server@1.7.17 @cubejs-backend/duckdb-driver@1.7.17

# The model says read_parquet('/data/...') because that is the container's mount
# point. Keeping the model identical in both places costs exactly one symlink —
# see the note in deploy/cube/cube.js.
ln -sfn "$SERVE_ROOT/current/data" /data

# --- 6. services ------------------------------------------------------------
log "systemd units"
install -m 644 "$HERE/systemd/evidence-cube.service"  /etc/systemd/system/
install -m 644 "$HERE/systemd/evidence-build.service" /etc/systemd/system/
install -m 644 "$HERE/systemd/evidence-build.timer"   /etc/systemd/system/
systemctl daemon-reload

log "caddy"
install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy

# --- 7. first build ---------------------------------------------------------
# Seeding needs the fixtures up; build.sh manages them from here on.
log "seeding the ADBC fixtures"
systemctl start postgresql clickhouse-server
sudo -u postgres psql -qc "select 1 from pg_roles where rolname='evidence'" | grep -q 1 \
	|| sudo -u postgres psql -qc "create role evidence login password 'evidence'"
sudo -u postgres psql -qc "select 1 from pg_database where datname='evidence'" | grep -q 1 \
	|| sudo -u postgres createdb -O evidence evidence

# Sources must run once before there is parquet to seed from.
#
# The cd is load-bearing. `npx --prefix` only says where to resolve the package
# from; the child still runs in the caller's directory, so `evidence sources`
# would read the wrong project and write its parquet outside $APP. And the
# extraction is not optional here — swallowing its exit status leaves an empty
# .evidence/template/static/data that the seed and the first build then quietly
# build on top of.
(cd "$APP" && sudo -u evidence env NODE_OPTIONS=--max-old-space-size=1024 \
	npx evidence sources)

# seed.sh already refuses loudly when the parquet is missing, so a failure here
# is a real one. Reporting it as "skipped" produced two empty ADBC fixtures and
# a site that only looks correct until someone opens the ADBC page.
sudo -u evidence "$APP/deploy/datasources/seed.sh"
systemctl stop postgresql clickhouse-server

log "first build"
sudo -u evidence "$APP/deploy/build.sh"

systemctl enable --now evidence-cube.service
systemctl enable --now evidence-build.timer

log "done"
cat <<-MSG

	site      http://$(hostname -I 2>/dev/null | awk '{print $1}')/
	cube      127.0.0.1:4000  (reachable only via /cubejs-api on the site)
	rebuild   systemctl start evidence-build     (nightly at 03:15)
	rollback  ln -sfn $SERVE_ROOT/releases/<older> $SERVE_ROOT/current

	free -m, and deploy/README.md for the memory budget.
MSG
