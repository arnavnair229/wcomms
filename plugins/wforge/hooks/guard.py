#!/usr/bin/env python3
"""PreToolUse guard for the Agent and Workflow tools.

Reads the usage snapshot the status-line bridge writes and decides, before any
fan-out, whether the call may run as asked, should run cheaper, or must wait.

  ok       -> allow
  soft     -> Agent: downshift model (opus/fable -> sonnet, unset -> sonnet) and
              effort to low unless already low/medium; Workflow: allow with a warning
  hard     -> Agent: allow only haiku; Workflow: deny
  unknown  -> allow, remind the user once per session to run /wforge:setup

Independently of the window, more than max_agents subagent launches in any
rolling 10-minute span are refused. Workflow runs count as one launch each;
their internal agents are capped inside the scripts.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wforge_common as W  # noqa: E402


def launches(session_id, record):
    """Rolling count of Agent/Workflow launches for this session."""
    path = os.path.join(W.state_dir(), "sessions", (session_id or "unknown") + ".json")
    data = W.read_json(path, {}) or {}
    now = time.time()
    stamps = [t for t in data.get("launches", []) if now - t < W.WINDOW_10M]
    if record:
        stamps.append(now)
    data["launches"] = stamps
    W.write_json(path, data)
    return len(stamps)


def allow(reason=None, updated=None, message=None):
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
    if reason:
        out["hookSpecificOutput"]["permissionDecisionReason"] = reason
    if updated is not None:
        out["hookSpecificOutput"]["updatedInput"] = updated
    if message:
        out["systemMessage"] = message
    W.emit(out)


def deny(reason):
    W.emit({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
        "systemMessage": reason,
    })


def main():
    inp = W.read_stdin_json()
    tool = inp.get("tool_name")
    if tool not in ("Agent", "Workflow"):
        return  # not ours; silence lets the call through
    tin = dict(inp.get("tool_input") or {})
    th = W.thresholds()
    snap = W.snapshot()
    lvl = W.level(snap, th)
    where = W.summary_line(snap)

    # Burst cap first: it applies whatever the window says.
    n = launches(inp.get("session_id"), record=False)
    if n >= th["max_agents"]:
        deny("wforge: %d subagent launches in the last 10 minutes (cap %d). Finish what is running, "
             "or do the next step inline. %s" % (n, th["max_agents"], where))
        return

    if lvl == "hard":
        if tool == "Workflow":
            deny("wforge: fan-out blocked, %s. Work inline on the current step, or run the bulk part on "
                 "the API lane (bin/wforge-bulk) which does not touch the window." % where)
            return
        if W.model_rank(tin.get("model")) == 1:   # haiku is allowed through
            launches(inp.get("session_id"), record=True)
            allow(message="wforge: %s. Haiku subagent allowed; nothing heavier until the window resets." % where)
            return
        deny("wforge: %s. Subagent refused: at this level only Haiku workers run. Re-issue with model "
             "haiku for mechanical work, do it inline, or wait for the reset." % where)
        return

    launches(inp.get("session_id"), record=True)

    if lvl == "soft":
        if tool == "Workflow":
            allow(message="wforge: %s. Workflow allowed, but keep this run small (prefer pipeline over "
                          "fan-out, haiku for checks)." % where)
            return
        changed = []
        model = tin.get("model")
        if tin.get("subagent_type") != "fork" and W.model_rank(model) != 1:
            if W.model_rank(model) >= 3 or not model:
                tin["model"] = "sonnet"
                changed.append("model->sonnet")
        if tin.get("effort") not in ("low", "medium"):
            tin["effort"] = "low"
            changed.append("effort->low")
        if changed:
            allow(reason="wforge downshift (%s): %s" % (", ".join(changed), where),
                  updated=tin,
                  message="wforge: %s. Subagent downshifted: %s." % (where, ", ".join(changed)))
        else:
            allow()
        return

    if lvl == "unknown":
        flag = os.path.join(W.state_dir(), "sessions", (inp.get("session_id") or "unknown") + ".warned")
        if not os.path.exists(flag):
            open(flag, "w").close()
            allow(message="wforge: usage window unknown, so the guard is passive. Run /wforge:setup "
                          "once to install the status-line bridge.")
            return
    allow()


if __name__ == "__main__":
    main()
