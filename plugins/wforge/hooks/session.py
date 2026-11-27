#!/usr/bin/env python3
"""SessionStart: tell Claude where the usage windows stand and which lane applies."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wforge_common as W  # noqa: E402


def crew_note():
    """One clause about the local crew backlog when the cwd has one; empty otherwise."""
    try:
        import subprocess
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        root = ""
    path = os.path.join(root or os.getcwd(), ".wforge", "crew.json")
    data = W.read_json(path, None)
    if not data:
        return ""
    tasks = data.get("tasks") or []
    counts = {}
    for t in tasks:
        counts[t.get("state")] = counts.get(t.get("state"), 0) + 1
    live = {k: v for k, v in counts.items() if k in ("ready", "held", "running")}
    if not live:
        return ""
    return " Crew backlog here: " + ", ".join("%d %s" % (v, k) for k, v in sorted(live.items())) + " (wforge-crew list)."


def main():
    W.read_stdin_json()
    th = W.thresholds()
    snap = W.snapshot()
    lvl = W.level(snap, th)
    where = W.summary_line(snap)
    lane = {
        "ok": "normal: subagents and workflows allowed within the tier table",
        "soft": "lean: subagents run on sonnet at low effort, workflows kept small",
        "hard": "inline only: workflows blocked, only haiku subagents",
        "unknown": "passive: window not known yet",
    }[lvl]
    api = "set" if os.environ.get("ANTHROPIC_API_KEY") else "unset"
    ctx = (
        "wforge status: %s. Lane: %s. API key in env: %s (bulk work on the API lane uses "
        "bin/wforge-bulk and never touches the subscription window). Thresholds: soft %d%%, hard %d%%, "
        "weekly %d%%, max %d subagent launches per 10 min. For any multi-step build request, use the "
        "wforge:forge skill before spawning anything. Several tasks or work while the user is away: "
        "wforge:crew. The user returning or asking where things stand: wforge:bearings. Wrapping up: wforge:stow.%s"
        % (where, lane, api, th["soft"], th["hard"], th["weekly"], th["max_agents"], crew_note())
    )
    W.emit({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}})


if __name__ == "__main__":
    main()
