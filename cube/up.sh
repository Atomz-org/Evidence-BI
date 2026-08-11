#!/usr/bin/env bash
#
# Start a local Cube over this project's parquet.
#
#   ./cube/up.sh          start
#   ./cube/up.sh down     stop and remove
#
# Prefers a direct bind mount of ./model and the Evidence parquet. On macOS the
# podman VM is refused access to ~/Documents, ~/Desktop and ~/Downloads by the
# OS privacy layer, so when the direct mount fails the model and data are staged
# into a temp directory the VM can read. Staged mode is a copy: re-run this
# script after editing a model file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
DATA="$ROOT/.evidence/template/static/data"
NAME=cube-noodle
IMAGE=cubejs/cube:v1.7.17

ENGINE="$(command -v podman || command -v docker || true)"
[ -n "$ENGINE" ] || { echo "need podman or docker on PATH" >&2; exit 1; }

if [ "${1:-up}" = "down" ]; then
  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  echo "removed $NAME"
  exit 0
fi

if [ ! -d "$DATA" ]; then
  echo "no parquet at $DATA — run 'npm run sources' first" >&2
  exit 1
fi

run_cube() {
  local model_src="$1" data_src="$2"
  "$ENGINE" run -d --name "$NAME" \
    -p 4000:4000 -p 15432:15432 \
    -v "$model_src:/cube/conf/model:ro" \
    -v "$data_src:/data:ro" \
    -e CUBEJS_DEV_MODE=true \
    -e CUBEJS_DB_TYPE=duckdb \
    -e CUBEJS_TIMEZONE=UTC \
    -e CUBEJS_API_SECRET=noodle-local-dev-secret \
    -e CUBEJS_SQL_PORT=15432 \
    -e CUBEJS_PG_SQL_PORT=15432 \
    -e CUBEJS_SQL_USER=cube \
    -e CUBEJS_SQL_PASSWORD=cube \
    -e CUBEJS_LOG_LEVEL=warn \
    "$IMAGE" >/dev/null
}

"$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true

if run_cube "$HERE/model" "$DATA" 2>/dev/null; then
  echo "cube up (live mount)"
else
  STAGE="${TMPDIR:-/tmp}/cube-noodle-stage"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$HERE/model" "$STAGE/model"
  cp -R "$DATA" "$STAGE/data"
  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  run_cube "$STAGE/model" "$STAGE/data"
  echo "cube up (staged copy at $STAGE — re-run after editing the model)"
fi

printf 'waiting for the API'
for _ in $(seq 1 60); do
  if curl -sf http://localhost:4000/cubejs-api/v1/meta >/dev/null 2>&1; then
    echo " ready"
    echo "  REST       http://localhost:4000/cubejs-api/v1"
    echo "  playground http://localhost:4000"
    echo "  SQL API    postgres://cube:cube@localhost:15432/cube"
    exit 0
  fi
  printf '.'; sleep 2
done
echo
echo "API did not come up; logs:" >&2
"$ENGINE" logs --tail 30 "$NAME" >&2
exit 1
