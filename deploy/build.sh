#!/usr/bin/env bash
#
# The build phase, sequenced so it fits on a 2 GB box.
#
# Measured on this project (see deploy/README.md, "The measurement"): a cold
# `evidence build` peaks around 2.0 GB RSS and OOMs outright at a 1792 MB heap
# cap. A 2 GB server has ~1.85 GB usable. So the build does not fit in physical
# memory and no amount of config makes it fit — the design has to give it room
# rather than pretend it needs less.
#
# Three levers, applied in order:
#
#   1. Nothing else is resident while it runs. Cube (~220 MB) is stopped, and
#      Postgres/ClickHouse are up only for the seconds `evidence sources` needs
#      them. That returns ~600 MB to the build.
#   2. zram gives the shortfall back. A JS heap compresses ~3:1 under zstd, so a
#      2 GB zram device turns ~1.85 GB of physical RAM into ~3 GB of effective
#      working set. deploy/zram-setup.sh installs it.
#   3. The heap cap is set explicitly. Node sizes its default heap from visible
#      RAM, so on a 2 GB box it picks ~1 GB and the build dies with
#      "Ineffective mark-compacts near heap limit" long before swap is touched.
#      Raising the cap is what lets the pressure valve be reached at all.
#
# The live site is never taken down: the build lands in a new directory and the
# `current` symlink is flipped at the end.
#
#   deploy/build.sh              full build (sources + site)
#   deploy/build.sh --no-sources reuse the existing parquet, rebuild the site
#   deploy/build.sh --rebuild-dbt run dbt first, then everything
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# shellcheck source=/dev/null
[ -f "$HERE/env" ] && . "$HERE/env"

SERVE_ROOT="${SERVE_ROOT:-/srv/evidence}"
HEAP_MB="${EVIDENCE_BUILD_HEAP_MB:-2048}"
RUN_SOURCES=1
REBUILD_DBT=0

for arg in "$@"; do
	case "$arg" in
		--no-sources) RUN_SOURCES=0 ;;
		--rebuild-dbt) REBUILD_DBT=1 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# systemctl is absent when this runs on a laptop; every service call is
# advisory so the script stays usable outside the server.
svc() {
	have systemctl || return 0
	systemctl "$@" >/dev/null 2>&1 || true
}

# --- 0. sanity: is there room to do this at all? ----------------------------
if have free; then
	TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
	SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
	log "memory: ${TOTAL_MB} MB RAM + ${SWAP_MB} MB swap/zram"
	if [ "$SWAP_MB" -lt 1024 ] && [ "$TOTAL_MB" -lt 3000 ]; then
		cat >&2 <<-MSG

		Refusing to start: ${TOTAL_MB} MB RAM and only ${SWAP_MB} MB swap.

		A cold build of this project peaks near 2 GB. Without zram or a swapfile
		the OOM killer will take the build — and, on a box this size, possibly
		sshd with it. Run:

		    sudo deploy/zram-setup.sh

		then try again. Override with SWAP_CHECK=0 if you know better.
		MSG
		[ "${SWAP_CHECK:-1}" = "1" ] && exit 1
	fi
fi

# --- 1. hand the box to the build ------------------------------------------
log "stopping the serve plane's optional services"
svc stop evidence-cube.service

# The ADBC fixtures are the distro's own packages, tuned by the drop-ins in
# deploy/datasources/ and left disabled at boot — they are build-time only.
PG_SVC="${PG_SVC:-postgresql.service}"
CH_SVC="${CH_SVC:-clickhouse-server.service}"

cleanup() {
	log "restoring services"
	svc stop "$PG_SVC"
	svc stop "$CH_SVC"
	svc start evidence-cube.service
}
trap cleanup EXIT

# --- 2. dbt (optional) ------------------------------------------------------
if [ "$REBUILD_DBT" = "1" ]; then
	log "dbt build"
	REBUILD=1 ./scripts/sync-dbt.sh
elif [ "$RUN_SOURCES" = "1" ] && [ -x ./scripts/sync-dbt.sh ]; then
	:
fi

# --- 3. sources -------------------------------------------------------------
# `evidence sources` aborts on the FIRST unreachable datasource, and this
# project has two ADBC sources pointed at a local Postgres and ClickHouse. They
# must be up for the extraction and are dead weight the moment it finishes.
if [ "$RUN_SOURCES" = "1" ]; then
	log "starting the ADBC datasources"
	svc start "$PG_SVC"
	svc start "$CH_SVC"

	printf 'waiting for clickhouse'
	READY=0
	for _ in $(seq 1 60); do
		if curl -sf 'http://127.0.0.1:8123/ping' >/dev/null 2>&1; then READY=1; break; fi
		printf '.'; sleep 1
	done
	echo
	if [ "$READY" = "0" ]; then
		cat >&2 <<-'MSG'

		ClickHouse did not answer on 127.0.0.1:8123.

		This is fatal rather than a warning: `evidence sources` aborts on the
		first unreachable datasource, and adbc_clickhouse sorts first, so the
		parquet for every other source would be silently left stale.
		MSG
		exit 1
	fi

	log "evidence sources"
	npx evidence sources

	# Freed before the build starts — this is ~390 MB the site build gets back.
	log "stopping the ADBC datasources"
	svc stop "$PG_SVC"
	svc stop "$CH_SVC"
fi

# --- 4. the site ------------------------------------------------------------
# EVIDENCE_BUILD_DIR is read by the static adapter (see .evidence/template/
# svelte.config.js), so the build never writes over what is being served.
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$SERVE_ROOT/releases/$STAMP"
mkdir -p "$STAGE"

log "evidence build -> $STAGE  (heap cap ${HEAP_MB} MB)"
NODE_OPTIONS="--max-old-space-size=${HEAP_MB}" \
	EVIDENCE_BUILD_DIR="$STAGE" \
	npx evidence build

# --- 5. precompress ---------------------------------------------------------
"$HERE/precompress.sh" "$STAGE"

# --- 6. publish atomically --------------------------------------------------
log "publishing"
ln -sfn "$STAGE" "$SERVE_ROOT/current.new"
mv -Tf "$SERVE_ROOT/current.new" "$SERVE_ROOT/current" 2>/dev/null \
	|| { rm -f "$SERVE_ROOT/current"; ln -sfn "$STAGE" "$SERVE_ROOT/current"; }

# Keep the previous two releases so a bad build can be rolled back by moving one
# symlink; anything older is 137 MB of nothing.
ls -1dt "$SERVE_ROOT"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf

log "done — $SERVE_ROOT/current -> $STAGE"
