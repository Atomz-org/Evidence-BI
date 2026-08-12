#!/usr/bin/env bash
#
# Compress the build once, at build time, so the web server never compresses
# anything at request time.
#
# This is the cheapest large win in the whole stack. `build/_app/immutable`
# ships two duckdb-wasm binaries — 33 MB and 38 MB — because the browser picks
# the MVP or the exception-handling build at load. Brotli takes that pair from
# 71 MB to roughly 15 MB. Compressing on the fly instead would cost CPU and a
# multi-megabyte buffer per concurrent reader, which is exactly the kind of
# per-request memory a 2 GB box cannot spend.
#
#   deploy/precompress.sh <build-dir>
set -euo pipefail

DIR="${1:?usage: precompress.sh <build-dir>}"
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Only text-ish and wasm payloads. Skipping already-compressed formats (png,
# woff2, parquet's internal compression) avoids spending minutes to save bytes
# that are not there.
#
# Deliberately portable: no `mapfile` (bash 4+, and macOS ships 3.2), no
# `find -regextype` and no `du --files0-from` (both GNU-only). This script runs
# on the server under Mode B and on a developer machine under Mode A, and
# silently doing nothing on one of them is worse than being a little plain.
EXTS='\.(js|mjs|css|html|json|svg|wasm|txt|map|webmanifest|arrow)$'

COUNT=0
printf '==> precompressing %s\n' "$DIR"

# Both compressors create their output before they can fail, so writing straight
# to "$f.br"/"$f.gz" leaves a truncated sibling behind on a kill or a full disk —
# and the web server will happily hand that to the next client that negotiates
# the encoding, which reads as a corrupt site rather than as a failed build.
# Compress beside the target, rename only on success, and take the build down
# with us if compression fails at all.
TMP=""
trap 'rm -f "$TMP"' EXIT

# -j$(nproc) would be faster and is precisely what we must not do: parallel
# brotli at maximum quality on a 38 MB wasm allocates a large window per worker.
# One at a time keeps the peak bounded on a box that has none to spare.
while IFS= read -r f; do
	case "$f" in *.br|*.gz) continue ;; esac
	if have brotli && [ ! -f "$f.br" ]; then
		TMP="$(mktemp "$f.br.XXXXXX")"
		# --force: mktemp has already created the file brotli would refuse to
		# overwrite.
		if ! brotli --force --quality=11 --lgwin=24 --output="$TMP" "$f"; then
			rm -f "$TMP"; TMP=""
			echo "brotli failed: $f" >&2
			exit 1
		fi
		mv -f "$TMP" "$f.br"; TMP=""
	fi
	if have gzip && [ ! -f "$f.gz" ]; then
		TMP="$(mktemp "$f.gz.XXXXXX")"
		if ! gzip -9 -c "$f" > "$TMP"; then
			rm -f "$TMP"; TMP=""
			echo "gzip failed: $f" >&2
			exit 1
		fi
		mv -f "$TMP" "$f.gz"; TMP=""
	fi
	COUNT=$((COUNT + 1))
done <<EOF
$(find "$DIR" -type f -size +1k | grep -E "$EXTS")
EOF

printf '    %d files compressed\n' "$COUNT"

RAW=$(find "$DIR" -type f ! -name '*.br' ! -name '*.gz' -exec cat {} + 2>/dev/null | wc -c)
BR=$(find "$DIR" -name '*.br' -exec cat {} + 2>/dev/null | wc -c)
printf '    raw %s MB  ·  br %s MB (of the compressible part)\n' \
	"$((RAW / 1048576))" "$((BR / 1048576))"
