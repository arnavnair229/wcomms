---
name: nightshift
description: Run an overnight loop of small committed improvements toward one objective on the API lane, never on the subscription window. Use when the user says "overnight", "while I sleep", "nightshift", "good night have fun", or wants unattended iteration.
---

# nightshift

`bin/wforge-nightshift` is a shell loop: each iteration is one headless Claude Code turn on `ANTHROPIC_API_KEY` that makes one small change, appends a line to `NIGHTSHIFT.md`, and is committed only if the check command passes. Failed checks roll the tree back. It runs on a fresh branch `wforge/night-<date>`, never pushes, and stops at the iteration cap, the time cap, two idle iterations, or a stop file.

1. Check the lane: `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-usage" --json`. If `api_key_present` is false, stop here and explain: an unattended loop on a plan login drains the 5-hour window about twice as fast as interactive use and can lock the account by morning. The API lane is the only lane for this. Max, Ultra and Team plans include monthly API credits that cover it.

2. Agree the objective and the check with the user in one exchange: a one-sentence objective ("reduce duplicated validation code without changing behaviour"), a check command that proves nothing broke (`npm test`, `pytest -q`, `go test ./...`), the iteration cap (default 20) and the hour cap (default 6). Require a clean working tree on `main`.

3. Show the exact command and run it in the background only after the user says go:

   ```
   "${CLAUDE_PLUGIN_ROOT}/bin/wforge-nightshift" -n 20 -H 6 -m sonnet -c "<check>" "<objective>"
   ```

   Haiku is fine for mechanical objectives (formatting, docstrings, dead code). Opus is rarely worth it here.

4. Tell the user how to stop it (`touch .wforge/nightshift.stop`), where the log is (`.wforge/nightshift.log`), and that the morning review is `git log --oneline main..wforge/night-<date>`. Merging the branch is theirs.

Never start a nightshift with uncommitted work in the tree, on a branch other than main or master, or without a check command unless the user explicitly accepts unchecked commits.
