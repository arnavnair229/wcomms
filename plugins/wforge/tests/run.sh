#!/bin/sh
# Validate the plugin, syntax-check the workflows, run the hook and bridge tests.
set -eu
PLUGIN=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$PLUGIN/../.." && pwd)
cd "$PLUGIN"
echo "== plugin manifest"
claude plugin validate .
echo "== marketplace manifest"
claude plugin validate "$REPO"
echo "== workflow syntax"
for f in workflows/*.js; do
  node --check "$f" && echo "ok $f"
done
echo "== python syntax"
python3 -m py_compile hooks/*.py sdk/wforge_api.py
for f in bin/wforge-statusline bin/wforge-usage bin/wforge-setup bin/wforge-crew bin/wforge-voice bin/wforge-watch; do
  python3 -m py_compile "$f"
done
sh -n bin/wforge-bulk
sh -n bin/wforge-nightshift
echo "== hooks json"
python3 -c "import json; json.load(open('hooks/hooks.json')); print('ok hooks.json')"
echo "== tests"
python3 tests/test_hooks.py
