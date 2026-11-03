#!/usr/bin/env bash
# End-to-end check: two humans on two "machines" exercising hooks, MCP and claims.
#   WCOMMS_URL=http://localhost:8787 TOKEN_A=tok-alice TOKEN_B=tok-bob scripts/smoke.sh
# (TOKEN_A/B are INSECURE_DEV_TOKENS from worker/.dev.vars; they only work on localhost.)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
URL="${WCOMMS_URL:?}"; A="${TOKEN_A:?}"; B="${TOKEN_B:?}"
SA="sess-$RANDOM-aaaa"; SB="sess-$RANDOM-bbbb"
REPO="${WCOMMS_REPO:-test/demo}"
export WCOMMS_URL="$URL" WCOMMS_REPO="$REPO" WCOMMS_STATE_DIR="$(mktemp -d)"

hookA() { echo "{\"session_id\":\"$SA\",\"cwd\":\"$here\"}" | WCOMMS_TOKEN="$A" WCOMMS_MACHINE=mbp "$here/client/wcomms.sh" hook "$1"; }
hookB() { echo "{\"session_id\":\"$SB\",\"cwd\":\"$here\"}" | WCOMMS_TOKEN="$B" WCOMMS_MACHINE=vm "$here/client/wcomms.sh" hook "$1"; }
mcp() { # mcp TOKEN TOOL JSON_ARGS
  curl -sS "$URL/r/$REPO/mcp" -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" |
    python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(("ERROR: " if r.get("isError") else "") + r["content"][0]["text"])'
}
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "A session starts"; hookA start
step "B session starts"; hookB start
AID="alice@mbp-$(echo "$SA" | tr -cd 'a-zA-Z0-9' | cut -c1-6 | tr 'A-Z' 'a-z')"
BID="bob@vm-$(echo "$SB" | tr -cd 'a-zA-Z0-9' | cut -c1-6 | tr 'A-Z' 'a-z')"

step "MCP initialize + tools/list"
curl -sS "$URL/r/$REPO/mcp" -H "Authorization: Bearer $A" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' | head -c 160; echo
curl -sS "$URL/r/$REPO/mcp" -H "Authorization: Bearer $A" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import json,sys; print([t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'

step "A claims a study"
mcp "$A" claim "{\"agent\":\"$AID\",\"title\":\"Ensemble backtest of GFS vs HRRR temperature model\",\"branch\":\"exp/ensemble\"}"
step "B tries to start the same study under a different title -> blocked, shown A's claim"
mcp "$B" claim "{\"agent\":\"$BID\",\"title\":\"Backtest ensemble HRRR GFS temperature\"}"
step "B tries to claim A's task directly -> refused"
mcp "$B" claim "{\"agent\":\"$BID\",\"task_id\":1}"
step "B cannot post as A's agent"
mcp "$B" post "{\"agent\":\"$AID\",\"kind\":\"note\",\"body\":\"spoof\"}"
step "decision without a human is rejected"
mcp "$B" post "{\"agent\":\"$BID\",\"kind\":\"decision\",\"body\":\"go live with v3\"}"

step "B sets live config in state and asks A a direct question"
mcp "$B" state_set "{\"agent\":\"$BID\",\"key\":\"live_config\",\"value\":{\"model\":\"hrrr-v3\",\"max_pos\":50},\"note\":\"VM switched to hrrr-v3\",\"decided_by\":\"bob\"}"
mcp "$B" post "{\"agent\":\"$BID\",\"kind\":\"question\",\"to\":\"$AID\",\"body\":\"Does your backtest use the 06z or 12z run?\"}"

step "A's next prompt delivers it (UserPromptSubmit hook)"; hookA prompt
step "A's next tool call right after: rate-limited, prints nothing"; hookA tool; echo "(nothing above = ok)"
step "A finishes the task"
mcp "$A" update_task "{\"agent\":\"$AID\",\"task_id\":1,\"status\":\"done\",\"result\":\"HRRR beats GFS by 0.4F MAE on 90d; ensemble adds nothing. See results/ensemble.md\",\"links\":[\"results/ensemble.md\"],\"grade\":\"B\"}"
step "B tries to redo the finished study -> shown the result instead"
mcp "$B" claim "{\"agent\":\"$BID\",\"task_id\":1}"
step "B's PostToolUse hook (forced due) delivers the result as JSON additionalContext"
rm -f "$WCOMMS_STATE_DIR"/last-*; hookB tool; echo
step "who"; WCOMMS_TOKEN="$A" "$here/client/wcomms.sh" who
step "tasks"; WCOMMS_TOKEN="$A" "$here/client/wcomms.sh" tasks
step "human posts from CLI, search finds it"
WCOMMS_TOKEN="$A" "$here/client/wcomms.sh" post "Please nobody touch the VM until Friday" --kind note --topic ops
WCOMMS_TOKEN="$B" "$here/client/wcomms.sh" feed "VM"
step "sessions end"; hookA stop; hookA end; hookB end; WCOMMS_TOKEN="$A" "$here/client/wcomms.sh" who
step "bad token"; curl -s -o /dev/null -w '%{http_code}\n' "$URL/r/$REPO/api/who" -H 'Authorization: Bearer nope'
step "real GitHub auth (optional): your gh login on a repo you can push to, and on one you can't"
if [ -n "${GH_REPO_OK:-}" ] && command -v gh >/dev/null; then
  T="$(gh auth token)"
  curl -s -o /dev/null -w "push access to $GH_REPO_OK -> %{http_code}\n" "$URL/r/$GH_REPO_OK/api/who" -H "Authorization: Bearer $T"
  [ -n "${GH_REPO_NO:-}" ] && curl -s -w "\nno push access to $GH_REPO_NO -> %{http_code}\n" "$URL/r/$GH_REPO_NO/api/who" -H "Authorization: Bearer $T"
fi
