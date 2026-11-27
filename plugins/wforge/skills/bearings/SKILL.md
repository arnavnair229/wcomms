---
name: bearings
description: One-screen digest of where things stand: the usage window, the crew backlog, decisions waiting on the user, and the shared workspace if wcomms is connected. Use when the user returns to a session, asks "where were we", "status", or says "bearings".
---

# bearings

Run both, once:
- `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-usage" --json`
- `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-crew" report --json`

Then write four short sections, each at most four lines, in this order:

1. **Window.** 5-hour and 7-day percentages, when they reset, the lane in force. If unknown, say the bridge is not installed and point at `/wforge:setup`.
2. **Crew.** Running tasks with how long they have run; done in the last 24 hours with branch and measured cost; the measured total. If the backlog is empty, say so in one line.
3. **Decisions.** Every held task with its reason, and anything from this conversation that is waiting on the user. Number them so the user can answer by number.
4. **Shared.** If the wcomms MCP server is connected, call `inbox` and `tasks` and summarise anything addressed to this session or changed since the user was last here. If it is not connected, omit the section.

Add `file` to the request (`/wforge:bearings file`) to also write the same digest to `.wforge/bearings-<YYYY-MM-DD>.md`, replacing today's file.

Do not spawn agents. Do not read transcripts. If a section has nothing in it, one line, then move on. Then ask which decision to take first, or stop if there are none.
