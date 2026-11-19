#!/usr/bin/env python3
"""API-lane runner on the Claude Agent SDK.

Loads the wforge plugin into an SDK session billed to ANTHROPIC_API_KEY, so the
same skills, agents and workflows run without touching a subscription window.

    pip install claude-agent-sdk
    export ANTHROPIC_API_KEY=...      # key from the Console org linked to your plan credits
    python3 sdk/wforge_api.py --model haiku "summarize every TODO under src/"

Prints the final text. Exits 3 when no API key is present, on purpose: a plan
login here would count against the 5-hour window at the headless rate.
"""
import argparse
import asyncio
import os
import sys

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


async def run(task, model, cwd, max_turns):
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
        from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
    except ImportError:
        sys.exit("claude-agent-sdk is not installed: pip install claude-agent-sdk")

    opts = ClaudeAgentOptions(
        model=model,
        cwd=cwd,
        max_turns=max_turns,
        permission_mode="acceptEdits",
        setting_sources=["project"],
        plugins=[{"type": "local", "path": PLUGIN}],
    )
    final = []
    async for msg in query(prompt=task, options=opts):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    final.append(block.text)
        elif isinstance(msg, ResultMessage):
            usage = getattr(msg, "usage", None) or {}
            cost = getattr(msg, "total_cost_usd", None)
            sys.stderr.write("wforge-api: turns=%s cost_usd=%s usage=%s\n" % (
                getattr(msg, "num_turns", "?"), cost, usage))
    print("\n".join(final).strip())


def main():
    ap = argparse.ArgumentParser(description="Run a task on the wforge API lane")
    ap.add_argument("task")
    ap.add_argument("--model", default="haiku", help="haiku (default), sonnet or opus")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--max-turns", type=int, default=40)
    a = ap.parse_args()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.stderr.write("wforge-api: ANTHROPIC_API_KEY is not set; refusing to run on a plan login.\n")
        sys.exit(3)
    asyncio.run(run(a.task, a.model, a.cwd, a.max_turns))


if __name__ == "__main__":
    main()
