#!/usr/bin/env bash
#
# Run the real Rill over this project's own parquet.
#
#   ./rill/up.sh          start (native binary if present, else a container)
#   ./rill/up.sh down     stop and remove the container
#
# The Evidence pages do not need this — they compile rill/ to DuckDB and run it
# in the browser. Running Rill for real is how you check that the two agree,
# which is the only reason to keep the YAML in Rill's schema rather than in a
# convenient one.
#
# ./data is a copy of the Evidence parquet, because the model's read_parquet()
# paths are relative to the project root and a container cannot follow a symlink
# out of its mount. It is gitignored and re-copied on every run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SRC="$ROOT/.evidence/template/static/data"
NAME=rill-evidence
IMAGE=rilldata/rill:latest
PORT=9009

if [ "${1:-up}" = "down" ]; then
  ENGINE="$(command -v podman || command -v docker || true)"
  [ -n "$ENGINE" ] && "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  echo "removed $NAME"
  exit 0
fi

if [ ! -d "$SRC" ]; then
  echo "no parquet at $SRC — run 'npm run sources' first" >&2
  exit 1
fi

echo "staging parquet into rill/data"
rm -rf "$HERE/data"
cp -R "$SRC" "$HERE/data"

# The compiled module and the YAML must not have drifted, or `rill start` and
# the Evidence page would be rendering two different dashboards — which is
# exactly the failure this script exists to detect.
node "$ROOT/scripts/build-rill-model.mjs" --check

if command -v rill >/dev/null 2>&1; then
  echo "starting rill (native) on http://localhost:$PORT"
  exec rill start "$HERE" --port "$PORT"
fi

ENGINE="$(command -v podman || command -v docker || true)"
if [ -z "$ENGINE" ]; then
  cat >&2 <<'MSG'
Neither `rill` nor a container engine is on PATH.

  curl https://rill.sh | sh      install the binary
  ./rill/up.sh                   then run this again

The Evidence page at /rill does not need either — it compiles the same YAML and
runs it in the browser.
MSG
  exit 1
fi

"$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
echo "starting rill ($ENGINE) on http://localhost:$PORT"
exec "$ENGINE" run --rm --name "$NAME" \
  -p "$PORT:$PORT" \
  -v "$HERE:/project" \
  "$IMAGE" start /project --port "$PORT"
