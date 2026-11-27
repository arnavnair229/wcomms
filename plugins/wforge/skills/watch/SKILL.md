---
name: watch
description: Open the live wforge board in a second terminal: the usage window, every subagent running now, finished agents with the model, effort, tokens and time each one actually used, and the crew backlog. Use when the user asks what the agents are doing, which model ran, or says "watch", "board", "dashboard".
---

# watch

The board is a terminal program, not something that renders inside this conversation. Give the user the command to run in a second terminal split (in VS Code: the `+` on the terminal panel, or `Cmd+\` to split):

```
python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-watch"
```

Expand `${CLAUDE_PLUGIN_ROOT}` to the real path before showing it; the user's shell does not know that variable. It refreshes every three seconds and quits on Ctrl-C. `--root <repo>` points it at another repo's crew backlog, `--session <id>` filters to one Claude Code session.

If the user wants the numbers here instead, run `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-watch" --once` and show the output in a code block. Do not run the live loop from this session; it never exits.

What the rows mean, if asked:
- **running agents**: subagents alive right now, from the SubagentStart hook; the model is only known once they finish.
- **finished**: one row per subagent from its own transcript: the model that actually answered (so the tier the guard chose, or a downshift, is visible), effort, assistant turns, input tokens including cache reads and writes, output tokens, wall time.
- **last 24h by tier**: where the tokens went. If opus has more agents than haiku, the tier table is not being followed; say so.
- **crew backlog**: the same ledger `/wforge:bearings` reads, with cost in window points per finished task.

The board reads only local files wforge writes; it makes no API calls and costs nothing to leave open.
