#!/usr/bin/env bash
#
# Pull the latest upstream Evidence source into vendor/ and report whether it
# still matches the versions this project actually runs.
#
#   ./scripts/sync-evidence-upstream.sh          # fetch latest, show drift
#   ./scripts/sync-evidence-upstream.sh --check  # report only, fetch nothing
#
# Tracks two upstream repos:
#   vendor/evidence              evidence-dev/evidence      (the monorepo)
#   vendor/evidence-datasources  evidence-dev/datasources   (gsheets, influxdb)
#
# A submodule pins to a COMMIT, so upstream changes are never picked up
# silently — this script is the deliberate update, and the resulting pointer
# change must be committed like any other edit.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMODULES=(vendor/evidence vendor/evidence-datasources)
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

for sub in "${SUBMODULES[@]}"; do
    if [ ! -e "$HERE/$sub/.git" ]; then
        echo "$sub is not checked out. Run:" >&2
        echo "  git submodule update --init --recursive --depth 1" >&2
        exit 2
    fi
done

changed=0
for sub in "${SUBMODULES[@]}"; do
    path="$HERE/$sub"
    before="$(git -C "$path" rev-parse --short HEAD)"

    if [ "$CHECK_ONLY" -eq 0 ]; then
        echo "Fetching upstream for $sub..."
        git -C "$HERE" submodule update --remote --depth 1 -- "$sub"
    fi

    after="$(git -C "$path" rev-parse --short HEAD)"
    if [ "$before" = "$after" ]; then
        echo "$sub: already at $after (no upstream change)"
    else
        changed=1
        echo "$sub: $before -> $after"
        git -C "$path" log --oneline -5 | sed 's/^/    /'
    fi
done

if [ "$changed" -eq 1 ]; then
    echo
    echo "Commit the pointer move(s) to record them:"
    echo "  git add vendor && git commit -m 'chore(vendor): bump evidence upstream'"
fi

# --- drift check: vendored source vs. the versions npm actually installs ----
# The app runs against node_modules, NOT these checkouts. When they diverge,
# the component cookbook in .claude/skills/evidence-bi/references/components.md
# is being verified against source the project does not run.
echo
python3 - "$HERE" <<'PY'
import json, sys, glob, os

root = sys.argv[1]
declared = json.load(open(os.path.join(root, "package.json")))["dependencies"]

vendored = {}
for p in glob.glob(os.path.join(root, "vendor/**/package.json"), recursive=True):
    if f"{os.sep}node_modules{os.sep}" in p:
        continue
    try:
        d = json.load(open(p))
    except Exception:
        continue
    if isinstance(d.get("name"), str) and d["name"].startswith("@evidence-dev/"):
        vendored[d["name"]] = d.get("version")

rows, drift, unvendored = [], False, []
for name, spec in sorted(declared.items()):
    v = vendored.get(name)
    if v is None:
        unvendored.append(name)
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
if unvendored:
    print(f"\nnot in any vendored repo ({len(unvendored)}): {', '.join(unvendored)}")
if drift:
    print("\nDRIFT: vendored source is ahead of/behind what package.json installs.")
    print("Either bump package.json + `npm install`, or treat vendor/ as preview-only.")
else:
    print("\nNo drift: every vendored package matches the installed version.")
PY
