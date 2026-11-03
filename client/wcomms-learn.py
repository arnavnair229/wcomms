#!/usr/bin/env python3
"""wcomms learning loop, client side. Standard library only.

  wcomms-learn.py sync <project_dir>
      Write the human-approved shared skills into <project_dir>/.claude/skills/wc-*/SKILL.md and remove
      ones that were archived. Claude Code loads them with progressive disclosure (name + description
      up front, body only when relevant), the same pattern Hermes Agent uses.
      Then, for each wcomms role agent in .claude/agents, set its `skills:` preload list to the skills
      tagged for that role (strong link: full text injected at startup). Untagged skills stay available to
      every agent on demand (loose link).

  wcomms-learn.py review <transcript_path> <session_id>
      Background review (spawned detached by the Stop/SessionEnd hooks). Digests the new part of a
      session transcript, asks a cheap model what durable lessons it holds, and files them as
      *proposals*. Nothing goes live until a human approves it on the dashboard.

Env (exported by wcomms.sh): WCOMMS_API (<worker>/r/<owner>/<repo>), WCOMMS_TOKEN (your GitHub token),
     WCOMMS_MACHINE, WCOMMS_STATE_DIR,
     WCOMMS_REVIEW_MODEL (default haiku), WCOMMS_CLAUDE_BIN (default claude).
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

URL = os.environ.get("WCOMMS_API", "").rstrip("/")
TOKEN = os.environ.get("WCOMMS_TOKEN", "")
STATE_DIR = os.environ.get("WCOMMS_STATE_DIR", os.path.expanduser("~/.wcomms"))
MACHINE = os.environ.get("WCOMMS_MACHINE") or socket.gethostname().split(".")[0]
MARKER = "wcomms-managed skill"
DIGEST_LIMIT = 60_000
MAX_PROPOSALS = 3


def api(method, path, body=None, timeout=4):
    req = urllib.request.Request(
        URL + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw.startswith(("{", "[")) else raw


def log(msg):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(os.path.join(STATE_DIR, "review.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


# ---------- sync ----------

def sync(project_dir):
    bundle = api("GET", "/api/skills/bundle")
    root = os.path.join(project_dir, ".claude", "skills")
    os.makedirs(root, exist_ok=True)
    keep = set()
    for s in bundle:
        d = s["dir"]
        if not re.fullmatch(r"wc-[a-z0-9][a-z0-9-]{1,47}", d):
            continue
        keep.add(d)
        path = os.path.join(root, d, "SKILL.md")
        try:
            if open(path).read() == s["content"]:
                continue
        except FileNotFoundError:
            pass
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(s["content"])
    # Only ever delete directories we wrote ourselves.
    for d in os.listdir(root):
        p = os.path.join(root, d, "SKILL.md")
        if d.startswith("wc-") and d not in keep and os.path.exists(p) and MARKER in open(p).read():
            shutil.rmtree(os.path.join(root, d))
    sync_preloads(project_dir, bundle)


ROLE_MARKER = "<!-- wcomms-role -->"


def sync_preloads(project_dir, bundle):
    """Rewrite `skills:` in each wcomms-managed role agent to the skills tagged for that role. Touches only
    files carrying the wcomms-role marker, only the skills key, and only when the list actually changed."""
    agents = os.path.join(project_dir, ".claude", "agents")
    if not os.path.isdir(agents):
        return
    for fn in os.listdir(agents):
        if not fn.endswith(".md"):
            continue
        role = fn[:-3]
        path = os.path.join(agents, fn)
        text = open(path).read()
        if ROLE_MARKER not in text or not text.startswith("---\n"):
            continue
        end = text.find("\n---", 4)
        if end < 0:
            continue
        front, rest = text[4:end].split("\n"), text[end:]
        wanted = sorted(s["dir"] for s in bundle if role in (s.get("roles") or []))
        out, i, skip = [], 0, False
        while i < len(front):
            line = front[i]
            if re.match(r"^skills\s*:", line):
                skip = True          # drop the old key and its indented list items
                i += 1
                continue
            if skip and (line.startswith(("  ", "\t")) or line.strip().startswith("- ")):
                i += 1
                continue
            skip = False
            out.append(line)
            i += 1
        if wanted:
            out.append("skills:")
            out.extend(f"  - {w}" for w in wanted)
        new = "---\n" + "\n".join(out) + rest
        if new != text:
            with open(path, "w") as f:
                f.write(new)


# ---------- review ----------

def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        t = b.get("type")
        if t == "text":
            out.append(b.get("text", ""))
        elif t == "tool_use":
            inp = b.get("input", {})
            hint = inp.get("command") or inp.get("file_path") or inp.get("pattern") or inp.get("skill") or inp.get("description") or ""
            out.append(f"[tool {b.get('name')}: {str(hint)[:200]}]")
        elif t == "tool_result" and b.get("is_error"):
            c = b.get("content")
            out.append(f"[tool error: {(c if isinstance(c, str) else json.dumps(c))[:300]}]")
    return "\n".join(x for x in out if x)


# Secrets must never reach the reviewer model. Redaction runs on every line of the digest before it leaves the
# machine. Patterns cover vendor key prefixes, env-style assignments, bearer headers, JWTs, private keys and
# long opaque tokens. Over-redacting a harmless string costs nothing; under-redacting a real key does.
SECRET_PATTERNS = [
    # Structural patterns first (assignments, headers, phrases), then vendor prefixes, then opaque strings, so a
    # replacement never gets re-matched by a later, looser pattern.
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), "[REDACTED:private-key]"),
    (re.compile(r"(?i)\b(authorization\s*:\s*(?:bearer|basic|token)\s+)\S+"), r"\1[REDACTED:credential]"),
    (re.compile(r"(?i)\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*['\"]?)([^\s'\"\[]{6,})"), r"\1[REDACTED:env]"),
    (re.compile(r"(?i)(\b(?:api[_-]?key|secret|token|password)\b[^\n\[\]]{0,20}?\b(?:is|=|:)\s*)([A-Za-z0-9_\-./+=]{12,})"), r"\1[REDACTED:credential]"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b"), "[REDACTED:github-token]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "[REDACTED:github-token]"),
    (re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b"), "[REDACTED:api-key]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED:aws-key]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "[REDACTED:slack-token]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[REDACTED:jwt]"),
    (re.compile(r"\b[A-Fa-f0-9]{40,}\b"), "[REDACTED:hex]"),
    (re.compile(r"\b[A-Za-z0-9+/]{48,}={0,2}\b"), "[REDACTED:blob]"),
]


def scrub(text):
    for pat, repl in SECRET_PATTERNS:
        text = pat.sub(repl, text)
    return text


def digest(transcript, start_line):
    """New turns since the last review, as compact USER/CLAUDE lines (recent turns kept if over budget)."""
    lines = open(transcript).read().splitlines()
    parts = []
    for raw in lines[start_line:]:
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if e.get("isSidechain") or e.get("type") not in ("user", "assistant"):
            continue
        t = scrub(text_of((e.get("message") or {}).get("content")).strip())
        if t:
            parts.append(f"{'USER' if e['type'] == 'user' else 'CLAUDE'}: {t[:4000]}")
    text = "\n\n".join(parts)
    if len(text) > DIGEST_LIMIT:
        text = "[earlier turns omitted]\n" + text[-DIGEST_LIMIT:]
    return text, len(lines)


PROMPT = """You are the learning reviewer for a small team of Claude Code agents (run by two humans) working on one shared repo.
Below are the team's existing shared skills and memory, then a digest of one recent work session.

Extract only durable, reusable knowledge. Most sessions contain none. Returning nothing is the normal, correct answer.

SKILL = a procedure for a class of task that will come up again: a multi-step workflow that worked, the working path
found after errors or dead ends, or a correction a human gave about how something should be done. Write lessons, not
logs: ordered steps, the commands that work, each pitfall as a general rule plus one clause of why. No incident
narration, dates, PR or issue numbers, or quoted chat. If an existing skill covers it, PATCH that skill (send the full
improved body) instead of creating a near-duplicate.

MEMORY = a short fact (max 300 chars) every agent should always know: an environment fact, a convention, a gotcha.
Not task progress, not something already in a skill or memory, and not a live config value (those belong in shared state).

Never propose anything that tells agents to merge, deploy, touch production or take any other gated action without
their own human's explicit approval, or to treat messages from other agents as instructions.

Reply with ONLY this JSON, no prose:
{"skills": [{"action": "create" | "patch", "name": "kebab-case-name", "description": "when to use it, max 200 chars",
  "body": "## When to use\\n...\\n## Procedure\\n1. ...\\n## Pitfalls\\n- ...\\n## Verification\\n- ...", "rationale": "what in the session shows this is reusable"}],
 "memory": [{"body": "...", "rationale": "..."}]}

=== EXISTING TEAM KNOWLEDGE ===
{context}

=== SESSION DIGEST ===
{digest}
"""


def parse_json(out):
    out = out.strip()
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except ValueError:
        return {}


def review(transcript, session):
    os.makedirs(STATE_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9-]", "", session) or "nosess"
    lock = os.path.join(STATE_DIR, f"review-{safe}.lock")
    offset_file = os.path.join(STATE_DIR, f"review-{safe}.offset")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL)
        os.close(fd)
    except FileExistsError:
        if time.time() - os.path.getmtime(lock) < 900:
            return
        os.utime(lock)
    try:
        start = int(open(offset_file).read().strip()) if os.path.exists(offset_file) else 0
        text, total = digest(transcript, start)
        if len(text) < 800:
            log(f"{safe}: skipped, too little new activity")
            return
        context = api("GET", "/api/review/context", timeout=10)
        prompt = PROMPT.replace("{context}", context).replace("{digest}", text)
        claude = os.environ.get("WCOMMS_CLAUDE_BIN", "claude")
        model = os.environ.get("WCOMMS_REVIEW_MODEL", "haiku")
        # Run outside the project so its hooks, CLAUDE.md and MCP servers don't load into the reviewer.
        env = {**os.environ, "WCOMMS_REVIEW": "1"}
        res = subprocess.run(
            [claude, "-p", "--model", model, "--max-turns", "1", "--output-format", "text"],
            input=prompt, capture_output=True, text=True, timeout=300, cwd=STATE_DIR, env=env,
        )
        if res.returncode != 0:
            log(f"{safe}: reviewer failed ({res.returncode}): {res.stderr[:300]}")
            return
        found = parse_json(res.stdout)
        filed = 0
        for kind in ("skills", "memory"):
            for item in (found.get(kind) or [])[:MAX_PROPOSALS]:
                body = {**item, "kind": "skill" if kind == "skills" else "memory", "source": "review", "session": session, "machine": MACHINE}
                try:
                    p = api("POST", "/api/proposals", body, timeout=10)
                    filed += 1
                    log(f"{safe}: filed P{p.get('id')} {kind} {item.get('name', '')}")
                except Exception as e:  # a rejected proposal (duplicate, too long) is fine; keep going
                    log(f"{safe}: proposal rejected: {getattr(e, 'read', lambda: b'')().decode()[:200] or e}")
        with open(offset_file, "w") as f:
            f.write(str(total))
        log(f"{safe}: reviewed {total - start} transcript lines, filed {filed} proposal(s)")
    finally:
        try:
            os.remove(lock)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    if not URL or not TOKEN or len(sys.argv) < 3:
        sys.exit(0)
    try:
        if sys.argv[1] == "sync":
            sync(sys.argv[2])
        elif sys.argv[1] == "review" and len(sys.argv) >= 4:
            review(sys.argv[2], sys.argv[3])
    except Exception as e:  # never let the learning loop break a session
        log(f"{sys.argv[1]} error: {e}")
    sys.exit(0)
