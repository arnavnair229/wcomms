#!/usr/bin/env python3
"""SubagentStart and SubagentStop ledger. One script for both events; it branches on hook_event_name.

Start: record the agent in agents_open.json (id, type, session, cwd, started, window reading).
Stop:  remove it, read the subagent's own transcript for the model that actually ran, the number
       of assistant turns and the token usage, and append one record to agents.jsonl.

The hook prints nothing, so it never changes what the subagent or the parent does. The ledger is
what bin/wforge-watch renders and what proves which tier each step ran on.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wforge_common as W  # noqa: E402

KEEP_RECORDS = 2000


def tier_of(model):
    rank = W.model_rank(model)
    return {1: "haiku", 2: "sonnet", 3: "opus", 4: "fable"}.get(rank, "?")


def read_transcript(path):
    """Model, turns and summed usage from a subagent transcript. Missing file -> empty stats."""
    stats = {"model": None, "turns": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "effort": None}
    if not path:
        return stats
    path = os.path.expanduser(path)
    for row in W.read_jsonl(path):
        if row.get("type") != "assistant":
            continue
        msg = row.get("message") or {}
        if msg.get("model"):
            stats["model"] = msg["model"]
        if row.get("effort") and not stats["effort"]:
            stats["effort"] = row["effort"] if isinstance(row["effort"], str) else (row["effort"] or {}).get("level")
        u = msg.get("usage") or {}
        stats["turns"] += 1
        stats["input"] += int(u.get("input_tokens") or 0)
        stats["output"] += int(u.get("output_tokens") or 0)
        stats["cache_read"] += int(u.get("cache_read_input_tokens") or 0)
        stats["cache_write"] += int(u.get("cache_creation_input_tokens") or 0)
    return stats


def trim(path):
    rows = W.read_jsonl(path)
    if len(rows) > KEEP_RECORDS:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            for r in rows[-KEEP_RECORDS:]:
                f.write(W.json.dumps(r) + "\n")
        os.replace(tmp, path)


def main():
    inp = W.read_stdin_json()
    event = inp.get("hook_event_name")
    aid = inp.get("agent_id")
    if not aid or event not in ("SubagentStart", "SubagentStop"):
        return
    now = int(time.time())
    snap = W.snapshot()
    open_path = W.open_agents_path()
    open_agents = W.read_json(open_path, {}) or {}
    effort = inp.get("effort")
    effort = effort.get("level") if isinstance(effort, dict) else effort

    if event == "SubagentStart":
        open_agents[aid] = {
            "agent_id": aid, "agent_type": inp.get("agent_type") or "", "session_id": inp.get("session_id"),
            "cwd": inp.get("cwd"), "started": now, "five_start": snap["five"] if snap["known"] else None,
            "effort": effort,
        }
        W.write_json(open_path, open_agents)
        return

    start = open_agents.pop(aid, None) or {}
    W.write_json(open_path, open_agents)
    stats = read_transcript(inp.get("agent_transcript_path"))
    rec = {
        "t": now, "agent_id": aid, "agent_type": inp.get("agent_type") or start.get("agent_type") or "",
        "session_id": inp.get("session_id"), "cwd": inp.get("cwd") or start.get("cwd"),
        "started": start.get("started"), "duration_s": (now - start["started"]) if start.get("started") else None,
        "model": stats["model"], "tier": tier_of(stats["model"]), "effort": stats["effort"] or effort or start.get("effort"),
        "turns": stats["turns"], "input_tokens": stats["input"], "output_tokens": stats["output"],
        "cache_read_tokens": stats["cache_read"], "cache_write_tokens": stats["cache_write"],
        "five_start": start.get("five_start"), "five_end": snap["five"] if snap["known"] else None,
    }
    W.append_jsonl(W.agents_path(), rec)
    trim(W.agents_path())


if __name__ == "__main__":
    main()
