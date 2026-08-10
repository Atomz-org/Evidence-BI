#!/usr/bin/env bash
#
# Serve the precompressed ./build locally, through the config that ships.
#
# Why this exists rather than `node tests/static-server.mjs build 4321`: that
# server hands over raw files. It works, but it never looks at the .br/.gz
# siblings deploy/precompress.sh wrote, so the 71 MB duckdb-wasm pair crosses
# the wire uncompressed and you are not testing what a reader will actually get.
#
# This runs deploy/Caddyfile — the real one, pointed at ./build on a high port —
# so content negotiation, cache headers and the /cubejs-api proxy all behave as
# they will on the server.
#
#   deploy/serve-local.sh              ./build on :8080
#   deploy/serve-local.sh 9000         another port
#   PORT=9000 deploy/serve-local.sh    same
#
# For /noodle-cube, start Cube first (./cube/up.sh); the proxy points at
# 127.0.0.1:4000 exactly as in production, so no VITE_CUBE_API_URL is needed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

PORT="${1:-${PORT:-8080}}"
DIR="${EVIDENCE_ROOT:-$ROOT/build}"

command -v caddy >/dev/null 2>&1 || {
	cat >&2 <<-'MSG'
	caddy is not on PATH.

	    brew install caddy          macOS
	    apt install caddy           Debian/Ubuntu (see deploy/install.sh)

	Without it, `node tests/static-server.mjs build 4321` still serves the site —
	it just serves it uncompressed.
	MSG
	exit 1
}

[ -d "$DIR" ] || { echo "no build at $DIR — run 'npx evidence build' first" >&2; exit 1; }

if ! ls "$DIR"/_app/immutable/assets/*.br >/dev/null 2>&1; then
	echo "note: no .br files in $DIR — run deploy/precompress.sh '$DIR' to compress first" >&2
fi

echo "serving $DIR on http://localhost:$PORT  (precompressed, cube proxied to 127.0.0.1:4000)"
exec env EVIDENCE_ROOT="$DIR" EVIDENCE_LISTEN=":$PORT" \
	caddy run --config "$HERE/Caddyfile" --adapter caddyfile
