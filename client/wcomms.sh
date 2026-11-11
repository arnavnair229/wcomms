#!/usr/bin/env bash
# wcomms client: Claude Code hooks + a tiny CLI for humans.
#
#   hooks:  wcomms.sh hook start|prompt|tool|stop|end     (reads the hook JSON on stdin)
#   chat:   wcomms.sh join | check | tool <name> ['{"json":"args"}']   (from inside a running Claude Code chat)
#   CLI:    wcomms.sh who | tasks | feed [query] | inbox | post <body> [--kind K] [--to X] [--topic T]
#   runner: wcomms.sh runner install | uninstall | status | run   (answer approved nudges when no chat is open)
#   live:   wcomms.sh share <command...>   mirror a terminal to the town (watch-only, end-to-end encrypted)
#           wcomms.sh team-key set | show   the shared passphrase that encrypts live sessions (never leaves machines)
#   MCP:    wcomms.sh mcp-headers     (the .mcp.json headersHelper: prints your GitHub auth header)
#
# Config lives next to this script in wcomms.json ({"url": "<worker>", "repo": "owner/name"}), committed with the
# project. You authenticate as yourself with your GitHub login: `gh auth login`, or GH_TOKEN on a VM. No other keys.
# Without config or a GitHub login every hook is a silent no-op, and network calls are capped at a few seconds.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
conf() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$HERE/wcomms.json" 2>/dev/null | head -1; }
URL="${WCOMMS_URL:-$(conf url)}"
URL="${URL%/}"
REPO="${WCOMMS_REPO:-$(conf repo)}"
# Identity is your gh login. A GH_TOKEN/GITHUB_TOKEN in the environment is used only when gh isn't logged in,
# because project shells often carry tokens for other purposes (deploy scripts, CI) that can't push to this repo.
TOKEN="${WCOMMS_TOKEN:-}"
[ -z "$TOKEN" ] && command -v gh >/dev/null && TOKEN="$(gh auth token 2>/dev/null || true)"
[ -z "$TOKEN" ] && TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
API="$URL/r/$REPO"
export WCOMMS_API="$API" WCOMMS_TOKEN="$TOKEN" WCOMMS_REPO="$REPO"

if [ "${1:-}" = "mcp-headers" ]; then
  if [ -n "$TOKEN" ]; then printf '{"Authorization":"Bearer %s"}\n' "$TOKEN"; else echo '{}'; fi
  exit 0
fi
TOOL_INTERVAL="${WCOMMS_TOOL_INTERVAL:-120}"   # seconds between inbox checks on PostToolUse
REVIEW_EVERY="${WCOMMS_REVIEW_EVERY:-15}"      # turns between background learning reviews (0 = off)
LEARN="$HERE/wcomms-learn.py"
STATE_DIR="${WCOMMS_STATE_DIR:-$HOME/.wcomms}"
MACHINE="${WCOMMS_MACHINE:-$(hostname -s 2>/dev/null || hostname)}"
# The team passphrase for live sessions lives only on each person's machine (and in their browser).
TEAM_KEY_FILE="$STATE_DIR/team-key-$(printf '%s' "$REPO" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z')"
[ -z "${WCOMMS_TEAM_KEY:-}" ] && [ -f "$TEAM_KEY_FILE" ] && WCOMMS_TEAM_KEY="$(cat "$TEAM_KEY_FILE")"
export WCOMMS_TEAM_KEY="${WCOMMS_TEAM_KEY:-}"

# Inside the background reviewer's own claude process every hook is off, so reviews never trigger reviews.
if [ -z "$URL" ] || [ -z "$REPO" ] || [ -z "$TOKEN" ] || [ -n "${WCOMMS_REVIEW:-}" ]; then
  [ "${1:-}" = "hook" ] && exit 0
  echo "wcomms: needs $HERE/wcomms.json (run the installer) and a GitHub login (gh auth login, or GH_TOKEN)" >&2
  exit 1
fi

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'; }

api() { # api METHOD PATH [JSON]
  curl -sS --max-time "${WCOMMS_TIMEOUT:-4}" -X "$1" "$API$2" \
    -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    ${3:+--data "$3"}
}

urlenc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1" 2>/dev/null || printf '%s' "$1"; }

field() { printf '%s' "$2" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

hook() {
  local event="$1" input sid cwd branch transcript project
  input="$(cat)"
  sid="$(field session_id "$input")"
  cwd="$(field cwd "$input")"
  cwd="${cwd:-$PWD}"
  transcript="$(field transcript_path "$input")"
  project="${CLAUDE_PROJECT_DIR:-$cwd}"
  local base="\"session\":\"$(esc "$sid")\",\"machine\":\"$(esc "$MACHINE")\""

  case "$event" in
    start)
      branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
      learn sync "$project"
      api POST /api/hook/start "{$base,\"branch\":\"$(esc "$branch")\",\"cwd\":\"$(esc "$cwd")\"}" 2>/dev/null
      stamp "$sid"
      ;;
    prompt)
      stamp "$sid"
      api POST /api/hook/tick "{$base}" 2>/dev/null
      ;;
    tool)
      # Count uses of shared skills so the curator knows which ones earn their place.
      if printf '%s' "$input" | grep -q '"tool_name"[[:space:]]*:[[:space:]]*"Skill"'; then
        local skill role; skill="$(field skill "$input")"; role="$(field agent_type "$input")"
        case "$skill" in wc-*) api POST /api/skills/used "{$base,\"name\":\"$(esc "$skill")\",\"role\":\"$(esc "$role")\"}" >/dev/null 2>&1 ;; esac
      fi
      due "$sid" || exit 0
      stamp "$sid"
      api POST /api/hook/tick "{$base,\"format\":\"posttool\"}" 2>/dev/null
      ;;
    stop)
      local out; out="$(api POST /api/hook/stop "{$base}" 2>/dev/null)"
      local n; n="$(turns "$sid" 1)"
      [ $((n % 5)) -eq 0 ] && learn sync "$project"
      if [ "$REVIEW_EVERY" -gt 0 ] && [ "$n" -ge "$REVIEW_EVERY" ]; then
        turns "$sid" reset >/dev/null
        spawn_review "$transcript" "$sid"
      fi
      case "$out" in *'"decision"'*) printf '%s\n' "$out" ;; esac
      ;;
    end)
      api POST /api/hook/end "{$base}" >/dev/null 2>&1
      [ "$REVIEW_EVERY" -gt 0 ] && [ "$(turns "$sid" 0)" -ge 3 ] && spawn_review "$transcript" "$sid"
      rm -f "$STATE_DIR/last-$sid" "$STATE_DIR/turns-$sid"
      ;;
  esac
  exit 0
}

learn() { command -v python3 >/dev/null && [ -f "$LEARN" ] && timeout_cmd python3 "$LEARN" "$@" >/dev/null 2>&1; return 0; }
timeout_cmd() { if command -v timeout >/dev/null; then timeout 6 "$@"; else "$@"; fi; }

# The reviewer runs detached so it never slows the session; it files proposals humans approve later.
spawn_review() {
  [ -n "$1" ] && [ -f "$1" ] && command -v python3 >/dev/null && [ -f "$LEARN" ] || return 0
  command -v "${WCOMMS_CLAUDE_BIN:-claude}" >/dev/null || return 0
  nohup python3 "$LEARN" review "$1" "$2" >/dev/null 2>&1 &
}

# Per-session turn counter: turns SID 1 (increment), turns SID 0 (read), turns SID reset.
turns() {
  local f="$STATE_DIR/turns-${1:-x}" n
  mkdir -p "$STATE_DIR" 2>/dev/null
  n="$(cat "$f" 2>/dev/null || echo 0)"
  case "$2" in reset) n=0 ;; 1) n=$((n + 1)) ;; esac
  echo "$n" > "$f" 2>/dev/null
  echo "$n"
}

# Rate limiting for the PostToolUse hook: remember when we last checked, per session.
stamp() { mkdir -p "$STATE_DIR" 2>/dev/null && date +%s > "$STATE_DIR/last-${1:-x}" 2>/dev/null; return 0; }
due() {
  local last now
  last="$(cat "$STATE_DIR/last-${1:-x}" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [ $((now - last)) -ge "$TOOL_INTERVAL" ]
}

# Inside a running Claude Code chat, Bash sees CLAUDE_CODE_SESSION_ID, so a chat can join mid-session under the
# same agent id its hooks would give it. Outside a chat, commands act as you (your GitHub login).
SESSION="${CLAUDE_CODE_SESSION_ID:-}"
me() { [ -n "$SESSION" ] && printf '"session":"%s","machine":"%s"' "$(esc "$SESSION")" "$(esc "$MACHINE")"; }
with_me() { local m; m="$(me)"; if [ -n "$m" ]; then printf '{%s%s' "$m" "${1:+,${1#\{}}"; else printf '%s' "$1"; fi; }

# Any wcomms MCP tool over plain HTTP, so a chat can use wcomms through Bash before the MCP server is connected.
tool() {
  local name="${1:?usage: wcomms.sh tool <name> ['{json args}']}" args="${2:-}"
  [ -z "$args" ] && args='{}'
  args="$(printf '%s' "$args" | SESSION="$SESSION" MACHINE="$MACHINE" python3 -c '
import json, os, sys
a = json.loads(sys.stdin.read() or "{}")
if not a.get("agent") and os.environ["SESSION"]:
    a.update(session=os.environ["SESSION"], machine=os.environ["MACHINE"])
print(json.dumps(a))')" || { echo "wcomms: tool args must be a JSON object" >&2; exit 1; }
  curl -sS --max-time 10 -X POST "$API/mcp" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" |
    python3 -c '
import json, sys
r = json.load(sys.stdin)
if "error" in r: print("wcomms error:", r["error"].get("message", r["error"])); sys.exit(1)
res = r["result"]; print(("ERROR: " if res.get("isError") else "") + res["content"][0]["text"])'
}

# ---------- runner: a background job that answers approved nudges with headless Claude Code ----------
PROJECT_DIR="$(cd "$HERE/.." && pwd)"
RUNNER_LABEL="com.wcomms.runner.$(printf '%s' "$REPO" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z')"
RUNNER_PLIST="$HOME/Library/LaunchAgents/$RUNNER_LABEL.plist"
runner_cmd() {
  case "$1" in
    run) exec python3 "$HERE/wcomms-runner.py" run "$PROJECT_DIR" ;;
    once) exec python3 "$HERE/wcomms-runner.py" once "$PROJECT_DIR" ;;
    install)
      if [ "$(uname)" != "Darwin" ]; then
        echo "On Linux, run it under your process manager, e.g.: nohup $HERE/wcomms.sh runner run >> ~/.wcomms/runner.out 2>&1 &"; exit 0
      fi
      command -v claude >/dev/null || { echo "Claude Code (claude) not found on PATH" >&2; exit 1; }
      # launchd starts Python directly (no bash in between). On macOS a background job needs Full Disk Access to read a
      # project under Desktop, Documents or Downloads; granting it to this one binary is what makes that work.
      local py; py="$( [ -x /usr/bin/python3 ] && echo /usr/bin/python3 || command -v python3 )"
      local path_dirs; path_dirs="$(for b in claude gh python3 caffeinate; do command -v "$b" >/dev/null && dirname "$(command -v "$b")"; done | awk '!s[$0]++' | paste -sd: -):/usr/bin:/bin"
      mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"
      cat > "$RUNNER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$RUNNER_LABEL</string>
  <key>ProgramArguments</key><array><string>$py</string><string>$HERE/wcomms-runner.py</string><string>run</string><string>$PROJECT_DIR</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$path_dirs</string><key>WCOMMS_MACHINE</key><string>$MACHINE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$STATE_DIR/runner.out</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/runner.out</string>
</dict></plist>
PLIST
      launchctl bootout "gui/$(id -u)/$RUNNER_LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$RUNNER_PLIST" && echo "runner installed for $REPO ($RUNNER_LABEL). It answers nudges you approve when no Claude window takes them. Logs: $STATE_DIR/runner.log"
      case "$PROJECT_DIR" in
        "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
          echo
          echo "This project is in a folder macOS protects, so the background job needs one permission:"
          echo "  System Settings > Privacy & Security > Full Disk Access > + > press Cmd-Shift-G, enter: $py"
          echo "Then run: .claude/wcomms.sh runner status   (should show 'state = running')" ;;
      esac
      ;;
    uninstall)
      launchctl bootout "gui/$(id -u)/$RUNNER_LABEL" 2>/dev/null || true
      rm -f "$RUNNER_PLIST"; echo "runner removed for $REPO"
      ;;
    status)
      if [ -f "$RUNNER_PLIST" ]; then
        local info; info="$(launchctl print "gui/$(id -u)/$RUNNER_LABEL" 2>/dev/null)"
        printf '%s\n' "$info" | grep -E "state =|pid =|last exit code" | head -3
        if printf '%s' "$info" | grep -q "last exit code = 126"; then
          echo "exit 126 = macOS refused to let the job read the project. Grant Full Disk Access to $(sed -n 's#.*<string>\(/[^<]*python3[^<]*\)</string>.*#\1#p' "$RUNNER_PLIST" | head -1) (System Settings > Privacy & Security), then wait a minute."
        fi
      else echo "runner not installed (wcomms.sh runner install)"; fi
      tail -n 5 "$STATE_DIR/runner.log" 2>/dev/null || true
      ;;
    *) echo "usage: wcomms.sh runner install|uninstall|status|run" >&2; exit 1 ;;
  esac
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  hook) hook "${1:-}" ;;
  join)
    [ -z "$SESSION" ] && { echo "wcomms join runs from inside a Claude Code chat (CLAUDE_CODE_SESSION_ID is not set)" >&2; exit 1; }
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    learn sync "$(cd "$HERE/.." && pwd)"
    api POST /api/hook/start "{$(me),\"branch\":\"$(esc "$branch")\",\"cwd\":\"$(esc "$PWD")\"}"
    echo
    echo "Joined mid-chat. Use wcomms through Bash: .claude/wcomms.sh tool <name> '{json}' (agent id is filled in for you),"
    echo "and run .claude/wcomms.sh check between steps for new messages. If the wcomms hooks were installed after this chat"
    echo "started, they deliver messages automatically once reviewed in /hooks or after a restart."
    ;;
  check)
    [ -z "$SESSION" ] && { api GET /api/text/inbox; echo; exit 0; }
    out="$(api POST /api/hook/tick "{$(me)}")"
    printf '%s\n' "${out:-no new messages}"
    ;;
  tool) tool "$@" ;;
  runner) runner_cmd "${1:-status}" ;;
  share)
    [ -n "$TOKEN" ] && WCOMMS_LOGIN="$(gh api user -q .login 2>/dev/null || true)"
    WCOMMS_LOGIN="${WCOMMS_LOGIN:-}" exec python3 "$HERE/wcomms-share.py" "$@" ;;
  team-key)
    case "${1:-show}" in
      set)
        mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
        printf 'Team passphrase for %s (same for everyone on the team; it never leaves your machines): ' "$REPO" >&2
        stty -echo; IFS= read -r k; stty echo; echo >&2
        [ ${#k} -lt 8 ] && { echo "use at least 8 characters" >&2; exit 1; }
        printf '%s' "$k" > "$TEAM_KEY_FILE" && chmod 600 "$TEAM_KEY_FILE" && echo "saved to $TEAM_KEY_FILE. Teammates run the same command with the same passphrase; the dashboard asks for it once." ;;
      show) [ -f "$TEAM_KEY_FILE" ] && echo "team key is set ($TEAM_KEY_FILE)" || echo "no team key yet: .claude/wcomms.sh team-key set" ;;
      clear) rm -f "$TEAM_KEY_FILE"; echo "removed" ;;
      *) echo "usage: wcomms.sh team-key set|show|clear" >&2; exit 1 ;;
    esac ;;
  who) api GET /api/text/who; echo ;;
  tasks) api GET "/api/text/tasks${1:+?status=$1}"; echo ;;
  inbox) if [ -n "$SESSION" ]; then tool inbox; else api GET /api/text/inbox; echo; fi ;;
  feed) api GET "/api/text/feed?limit=40${1:+&q=$(urlenc "$1")}"; echo ;;
  post)
    body="${1:-}"; shift || true
    kind=note; to=all; topic=general; decided=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --kind) kind="$2"; shift 2 ;;
        --to) to="$2"; shift 2 ;;
        --topic) topic="$2"; shift 2 ;;
        --decided-by) decided="$2"; shift 2 ;;
        *) echo "unknown flag $1" >&2; exit 1 ;;
      esac
    done
    [ -z "$body" ] && { echo "usage: wcomms.sh post <body> [--kind K] [--to X] [--topic T] [--decided-by human]" >&2; exit 1; }
    json="{\"body\":\"$(esc "$body")\",\"kind\":\"$(esc "$kind")\",\"to\":\"$(esc "$to")\",\"topic\":\"$(esc "$topic")\",\"decided_by\":\"$(esc "$decided")\"}"
    api POST /api/messages "$(with_me "$json")"
    echo
    ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
