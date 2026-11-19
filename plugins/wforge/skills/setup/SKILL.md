---
name: setup
description: Install the wforge status-line bridge so hooks can read the usage window, and explain the API lane. Use once after installing the plugin, or when /wforge:budget reports the window as unknown.
---

1. Run `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-setup"` and show its output. It writes a `statusLine` entry into the user's settings.json, chaining any status line they already had. It is safe to run again. To undo it later: the same command with `--remove`.

2. Tell the user, in plain words:
   - The window appears in the status bar after the next API response in a new session. Until then the guard is passive.
   - Thresholds (soft, hard, weekly, max launches per ten minutes) live in `/config` under the wforge plugin.
   - The API lane: `bin/wforge-bulk` and `sdk/wforge_api.py` run work on `ANTHROPIC_API_KEY` and never touch the subscription window. Max, Ultra and Team plans include monthly API credits that cover this. They are claimed on claude.ai under Settings, Billing, API credits, by linking a Console organization, and the key must come from that organization. Pro has no credits; the lane still works with a paid key.

3. Do not restart the session for the user and do not edit settings.json by hand; the script did it.
