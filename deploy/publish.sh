#!/usr/bin/env bash
#
# Build here, serve there.
#
# A cold `evidence build` peaks near 2.8 GB (deploy/README.md, "The
# measurement"). A 2 GB server can be made to survive that with zram and
# careful sequencing — deploy/build.sh does exactly that — but it pages hard,
# and it is worth being honest that the machine is doing something it is not
# sized for.
#
# The alternative is to notice that the build's *output* is 97 MB of static
# files, and that nothing about producing them has to happen on the server.
# Build on the machine you already develop on, or any spare box, and ship the
# artifact. The server then never needs node, npm, node_modules, dbt,
# Postgres or ClickHouse at all — only Caddy and Cube, ~240 MB steady.
#
# This is still entirely self-hosted. It is one rsync over ssh between two
# machines you own; no cloud build service is involved.
#
#   deploy/publish.sh user@server
#   deploy/publish.sh user@server --no-build     # ship the existing ./build
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

TARGET="${1:?usage: publish.sh user@host [--no-build]}"
shift || true
DO_BUILD=1
for arg in "$@"; do
	[ "$arg" = "--no-build" ] && DO_BUILD=0
done

SERVE_ROOT="${SERVE_ROOT:-/srv/evidence}"
HEAP_MB="${EVIDENCE_BUILD_HEAP_MB:-2048}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. build locally -------------------------------------------------------
if [ "$DO_BUILD" = "1" ]; then
	log "evidence sources"
	npx evidence sources

	# A fresh directory, because SvelteKit emits content-hashed filenames and
	# leaves the previous ones behind. Publishing an unclean build ships every
	# bundle you have ever produced — and makes "is the fix actually in there?"
	# unanswerable by grep.
	rm -rf build
	log "evidence build  (heap cap ${HEAP_MB} MB)"
	NODE_OPTIONS="--max-old-space-size=${HEAP_MB}" npx evidence build
fi

[ -d build ] || { echo "no ./build to publish" >&2; exit 1; }

# --- 2. compress once, here -------------------------------------------------
# Done on the build machine so the server never spends CPU on it.
"$HERE/precompress.sh" build

# --- 3. ship ----------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
REMOTE="$SERVE_ROOT/releases/$STAMP"

# deploy/install.sh gives $SERVE_ROOT to the `evidence` user, and everything
# below — mkdir, rsync, the symlink swap, the release prune — runs as whichever
# account you ssh in as. Any other account fails somewhere in the middle of
# that, and the middle is the one place this is not safe to fail: a release
# directory half-populated, or fully populated with `current` never flipped.
# Ask the question once, before a single byte has moved.
#
# The variables below are meant to expand on THIS side (shellcheck SC2029) —
# $SERVE_ROOT is the local setting being asserted about the remote box — so
# they are single-quoted for the remote shell rather than escaped.
log "checking $TARGET can write $SERVE_ROOT"
# shellcheck disable=SC2029
ssh "$TARGET" "test -w '$SERVE_ROOT' && test -w '$SERVE_ROOT/releases'" || {
	cat >&2 <<-MSG

	$TARGET cannot write $SERVE_ROOT/releases.

	deploy/install.sh owns that tree as the 'evidence' user. Publish as an
	account that can write it — either be a member of the evidence group:

	    sudo usermod -aG evidence <the ssh user>
	    sudo chmod -R g+w $SERVE_ROOT

	or run install.sh with SERVE_ROOT pointed somewhere you own and pass the
	same SERVE_ROOT here.
	MSG
	exit 1
}

log "shipping to $TARGET:$REMOTE"
# shellcheck disable=SC2029  # $REMOTE is computed here; it must expand locally
ssh "$TARGET" "mkdir -p '$REMOTE'"

# --link-dest hard-links every file that is byte-identical to the live release,
# so an unchanged 38 MB wasm binary costs no disk and no transfer. Only what
# actually changed crosses the wire.
rsync -a --delete --info=stats1 \
	--link-dest="$SERVE_ROOT/current/" \
	build/ "$TARGET:$REMOTE/"

# --- 4. flip ----------------------------------------------------------------
# Atomic: readers mid-request finish against the old release, the next request
# gets the new one, and the site is never down.
log "publishing"
# shellcheck disable=SC2029  # both paths are decided here and expand locally
ssh "$TARGET" "
	set -e
	ln -sfn '$REMOTE' '$SERVE_ROOT/current.new'
	mv -Tf '$SERVE_ROOT/current.new' '$SERVE_ROOT/current'
	ls -1dt '$SERVE_ROOT'/releases/*/ | tail -n +4 | xargs -r rm -rf
"

log "done — $TARGET:$SERVE_ROOT/current -> $REMOTE"
echo "rollback: ssh $TARGET \"ln -sfn $SERVE_ROOT/releases/<older> $SERVE_ROOT/current\""
