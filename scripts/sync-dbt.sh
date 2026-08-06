#!/usr/bin/env bash
#
# Sync the dbt semantic layer into Evidence.
#
#   ./scripts/sync-dbt.sh              # copy the built dev.duckdb + refresh Evidence sources
#   REBUILD=1 ./scripts/sync-dbt.sh    # run dbt build first (needs the code-skills venv)
#
# Point at a different dbt project with DBT_PROJECT_DIR.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DBT_PROJECT_DIR="${DBT_PROJECT_DIR:-$HERE/../code-skills/skill-packs/dbt-skills/use-cases/example-order-revenue-mart/dbt_project}"
DBT_BIN="${DBT_BIN:-$HERE/../code-skills/.venv/bin/dbt}"
DB="$DBT_PROJECT_DIR/dev.duckdb"
DEST="$HERE/sources/dbt_semantic/dbt_semantic.duckdb"

if [ "${REBUILD:-0}" = "1" ]; then
    if [ ! -x "$DBT_BIN" ]; then
        echo "dbt not found at $DBT_BIN — set DBT_BIN or create the venv (see dbt project run_local.sh)." >&2
        exit 2
    fi
    (cd "$DBT_PROJECT_DIR" && "$DBT_BIN" build --profiles-dir . --target duckdb_dev --exclude resource_type:seed)
fi

if [ ! -f "$DB" ]; then
    echo "No built database at $DB — run the dbt project first (REBUILD=1, or its run_local.sh)." >&2
    exit 2
fi

cp "$DB" "$DEST"
echo "Synced $(du -h "$DEST" | cut -f1 | tr -d ' ') → sources/dbt_semantic/dbt_semantic.duckdb"

(cd "$HERE" && npm run sources)
