---
name: budget
description: Show the 5-hour and weekly usage windows, the lane wforge is enforcing, and what to run where. Use when the user asks how much is left, why fan-out was refused, or before a big job.
---

Run `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-usage"` and show its output verbatim in a code block.

Then add at most three sentences:
- If the level is `unknown`, say the status-line bridge is not installed and point at `/wforge:setup`.
- If the level is `soft` or `hard`, say what that changes for the next job and when the window resets.
- If an API key is present, say bulk work can run on the API lane with `wforge-bulk` and cost the window nothing.

Do not spawn anything. Do not estimate token counts you have not measured.
