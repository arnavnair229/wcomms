#!/usr/bin/env bash
# Lay wcomms over any GitHub project. Safe to re-run (it updates in place and keeps your edits).
#
#   scripts/install-into-repo.sh /path/to/project --url https://wcomms.<host>.workers.dev \
#       [--repo owner/name] [--with-backtester] [--gated "Live trading"] [--gated "Changing the prod VM"]
#
# Then commit the files it lists. Teammates need nothing but `gh auth login` and push access to the repo.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
proj="${1:?usage: install-into-repo.sh /path/to/project --url <worker url> [--repo owner/name] [--with-backtester] [--gated TEXT]...}"
shift
url=""; repo=""; backtester=0; gated=()
while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2%/}"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --with-backtester) backtester=1; shift ;;
    --gated) gated+=("$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
[ -z "$url" ] && [ -f "$proj/.claude/wcomms.json" ] && url="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$proj/.claude/wcomms.json")"
[ -z "$url" ] && { echo "--url <your wcomms worker> is required" >&2; exit 1; }
if [ -z "$repo" ]; then
  remote="$(git -C "$proj" remote get-url origin 2>/dev/null || true)"
  repo="$(printf '%s' "$remote" | sed -n -E 's#^(https://|git@|ssh://git@)github\.com[:/]([^/]+/[^/]+)$#\2#p' | sed 's/\.git$//')"
fi
[ -z "$repo" ] && { echo "couldn't read a github.com origin remote; pass --repo owner/name" >&2; exit 1; }

mkdir -p "$proj/.claude/agents"
cp "$here/client/wcomms.sh" "$here/client/wcomms-learn.py" "$here/client/wcomms-runner.py" "$here/client/wcomms-share.py" "$proj/.claude/"
chmod +x "$proj/.claude/wcomms.sh" "$proj/.claude/wcomms-learn.py" "$proj/.claude/wcomms-runner.py" "$proj/.claude/wcomms-share.py"
printf '{\n  "url": "%s",\n  "repo": "%s"\n}\n' "$url" "$repo" > "$proj/.claude/wcomms.json"

# Role agents: add missing ones, refresh ones we installed, never overwrite one someone wrote by hand.
roles=(planner researcher coder reviewer)
[ "$backtester" = 1 ] && roles+=(backtester)
for r in "${roles[@]}"; do
  src="$here/repo-kit/.claude/agents/$r.md"; dest="$proj/.claude/agents/$r.md"
  if [ ! -f "$dest" ] || grep -q '<!-- wcomms-role -->' "$dest"; then cp "$src" "$dest"; else echo "kept your own .claude/agents/$r.md"; fi
done

# The /wcomms skill: lets any chat, including one already running, join and use wcomms through Bash.
mkdir -p "$proj/.claude/skills/wcomms"
dest="$proj/.claude/skills/wcomms/SKILL.md"
if [ ! -f "$dest" ] || grep -q '<!-- wcomms-role -->' "$dest"; then cp "$here/repo-kit/.claude/skills/wcomms/SKILL.md" "$dest"; fi

touch "$proj/.gitignore"
for line in '.claude/skills/wc-*/'; do
  grep -qxF "$line" "$proj/.gitignore" || printf '\n# wcomms shared skills (synced from the hub at session start)\n%s\n' "$line" >> "$proj/.gitignore"
done

GATED="$(printf '%s\n' "${gated[@]+"${gated[@]}"}")" python3 - "$here" "$proj" "$url" "$repo" <<'PY'
import json, os, sys
here, proj, url, repo = sys.argv[1:5]

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except FileNotFoundError: return {}

def save(p, d):
    with open(p, "w") as f: json.dump(d, f, indent=2); f.write("\n")

# Hooks: merge into .claude/settings.json without duplicating or touching other settings.
sp = os.path.join(proj, ".claude", "settings.json")
settings = load(sp)
hooks = settings.setdefault("hooks", {})
for event, groups in load(os.path.join(here, "repo-kit/.claude/settings.wcomms.json"))["hooks"].items():
    existing = hooks.setdefault(event, [])
    for g in groups:
        cmd = g["hooks"][0]["command"]
        if not any(h.get("command") == cmd for eg in existing for h in eg.get("hooks", [])):
            existing.append(g)
save(sp, settings)

# MCP: remote HTTP server; the helper prints your own GitHub token as the auth header at connect time.
mp = os.path.join(proj, ".mcp.json")
mcp = load(mp)
mcp.setdefault("mcpServers", {})["wcomms"] = {
    "type": "http",
    "url": f"{url}/r/{repo}/mcp",
    "headersHelper": ".claude/wcomms.sh mcp-headers",
}
save(mp, mcp)

# CLAUDE.md protocol, with this project's gated actions (kept from a previous install unless new ones are given).
cp = os.path.join(proj, "CLAUDE.md")
proto = open(os.path.join(here, "repo-kit/CLAUDE.wcomms.md")).read().strip()
current = open(cp).read() if os.path.exists(cp) else ""
start_tag, end_tag, gated_tag = "<!-- wcomms-protocol -->", "<!-- /wcomms-protocol -->", "### Gated actions (project-specific)\n"
new_gated = [g.strip() for g in os.environ.get("GATED", "").splitlines() if g.strip()]
old_gated = ""
if start_tag in current and gated_tag in current:
    old_gated = current[current.index(gated_tag) + len(gated_tag):current.index(end_tag)].strip()
if new_gated:
    gated = "\n".join(f"- {g}" for g in new_gated)
else:
    gated = old_gated or "- (none listed yet: add this project's own, one per line, e.g. `- Live trading` or `- Changing the production VM`)"
proto = proto.replace("{{GATED}}", gated)
if start_tag in current:
    s, e = current.index(start_tag), current.index(end_tag) + len(end_tag)
    current = current[:s] + proto + current[e:]
else:
    current = current.rstrip() + ("\n\n" if current else "") + proto
with open(cp, "w") as f: f.write(current if current.endswith("\n") else current + "\n")
PY

cat <<MSG
wcomms installed for $repo -> $url/r/$repo/
Commit these:  .claude/wcomms.sh .claude/wcomms-learn.py .claude/wcomms-runner.py .claude/wcomms-share.py .claude/wcomms.json .claude/agents/ .claude/skills/wcomms/ .claude/settings.json .mcp.json CLAUDE.md .gitignore
Each teammate: has push access to $repo, runs 'gh auth login' once, pulls, opens Claude Code here and approves the wcomms MCP server.
Already-running chats: type /wcomms (or ask Claude to run .claude/wcomms.sh join) to join without restarting.
Optional, per person: .claude/wcomms.sh runner install   answers approved nudges when no Claude window is open.
Live sessions: .claude/wcomms.sh team-key set (once, same passphrase for the team), then .claude/wcomms.sh share claude
Dashboard:     $url/r/$repo/
MSG
