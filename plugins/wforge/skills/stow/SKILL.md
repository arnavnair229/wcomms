---
name: stow
description: End-of-session sweep. Settle the crew backlog, capture durable knowledge into CLAUDE.md or memory with the user's approval, share what belongs to the team through wcomms, and say what is safe to compact. Use when the user is wrapping up, says "stow", "wrap up", "save state", or before a long break.
---

# stow

A sweep, not a summary. Three passes, then one short report.

## 1. Backlog

Run `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-crew" report`. For every `running` task, decide from what you know whether it finished (`done` with result and branch), is parked on a decision (`hold` with the reason), or must stay running. Any task the user mentioned this session but never filed: file it now with `add`.

## 2. Knowledge

List what this session learned that would still be true next week and is not already written down: a convention, a gotcha, a command that works, a decision and its reason. Keep it to the five most useful items. For each, propose where it goes:
- project rule or convention: the repo's `CLAUDE.md`
- how the user likes to work: your memory directory
- something every agent on this repo should know: wcomms `propose_memory` or `propose_skill`, if the server is connected

Show the proposed text as a diff or quoted block. Write only what the user approves. Never write secrets, tokens, hostnames of private services or anything from a file marked private.

## 3. Loose ends

Branches created this session and not merged (`git branch --list 'wforge/*'` plus any you named), uncommitted changes (`git status --short`), background workflows still running. One line each. Do not merge, push, delete or stash anything.

## Report

What was filed or settled, what was written where, the loose ends, and the measured window cost of the session from `wforge-usage --marks` if marks exist. Finish with one sentence on whether it is safe to `/compact` or `/clear`: safe when everything above is on disk, not safe when a decision is still only in this conversation.
