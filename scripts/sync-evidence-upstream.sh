#!/usr/bin/env bash
#
# Pull the latest upstream Evidence source into vendor/evidence and report
# whether it still matches the versions this project actually runs.
#
#   ./scripts/sync-evidence-upstream.sh          # fetch latest main, show drift
#   ./scripts/sync-evidence-upstream.sh --check  # report only, fetch nothing
#
# A submodule pins to a COMMIT, so upstream changes are never picked up
# silently — this script is the deliberate update, and the resulting pointer
# change must be committed like any other edit.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$HERE/vendor/evidence"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -d "$SUB/.git" ] && [ ! -f "$SUB/.git" ]; then
    echo "vendor/evidence is not checked out. Run:" >&2
    echo "  git submodule update --init --recursive --depth 1" >&2
    exit 2
fi

before="$(git -C "$SUB" rev-parse --short HEAD)"

if [ "$CHECK_ONLY" -eq 0 ]; then
    echo "Fetching upstream evidence-dev/evidence main..."
    git submodule update --remote --depth 1 -- vendor/evidence
fi

after="$(git -C "$SUB" rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
    echo "vendor/evidence: already at $after (no upstream change)"
else
    echo "vendor/evidence: $before -> $after"
    git -C "$SUB" log --oneline -5
    echo
    echo "Commit the pointer move to record it:"
    echo "  git add vendor/evidence && git commit -m 'chore(vendor): bump evidence upstream to $after'"
fi

# --- drift check: vendored source vs. the versions npm actually installs ----
# The app runs against node_modules, NOT this submodule. When these diverge,
# the component cookbook in .claude/skills/evidence-bi/references/components.md
# is being verified against source the project does not run.
echo
python3 - "$HERE" <<'PY'
import json, sys, glob, os

root = sys.argv[1]
declared = json.load(open(os.path.join(root, "package.json")))["dependencies"]

vendored = {}
for p in glob.glob(os.path.join(root, "vendor/evidence/packages/**/package.json"), recursive=True):
    if f"{os.sep}node_modules{os.sep}" in p:
        continue
    try:
        d = json.load(open(p))
    except Exception:
        continue
    if isinstance(d.get("name"), str) and d["name"].startswith("@evidence-dev/"):
        vendored[d["name"]] = d.get("version")

rows, drift = [], False
for name, spec in sorted(declared.items()):
    v = vendored.get(name)
    if v is None:
        continue
    want = spec.lstrip("^~")
    status = "match" if v == want else "DRIFT"
    if status == "DRIFT":
        drift = True
    rows.append((name, want, v, status))

if rows:
    print(f"vendored-vs-declared[{len(rows)}]{{package,declared,vendored,status}}:")
    for r in rows:
        print("  " + ",".join(r))
if drift:
    print("\nDRIFT: vendored source is ahead of/behind what package.json installs.")
    print("Either bump package.json + `npm install`, or treat vendor/ as preview-only.")
else:
    print("\nNo drift: vendored source matches the installed versions.")
PY
