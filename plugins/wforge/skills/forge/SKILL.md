---
name: forge
description: Size a build request, pick the cheapest lane that does it well, and run it with the right model per step and a capped agent count. Use for any multi-step build, refactor, migration or review before spawning anything.
---

# forge

You are about to do work that could fan out. Decide how, before you spawn.

## 1. Read the window

Run `python3 "${CLAUDE_PLUGIN_ROOT}/bin/wforge-usage" --json` once. It returns `level` (ok, soft, hard, unknown), the 5-hour and 7-day percentages, reset times and whether an API key is in the environment. The PreToolUse guard enforces the same levels; this step is so you plan with them instead of bouncing off them.

## 2. Size the task

| Size | Looks like | Lane |
|---|---|---|
| S | One file, one function, a rename, a config change, a question | Inline. No subagents. |
| M | Two to four files with a clear spec, or one investigation that would flood your context | Up to three subagents from the tier table. |
| L | Many files, several independent pieces, or a build that needs plan then verify | One workflow. |
| Bulk | The same mechanical thing across many items, or a long read of logs and docs | API lane when `api_key_present` is true, otherwise a workflow with haiku workers under the cap. |

When in doubt, size down. Most requests are S or M. A workflow for an S task costs ten times the work and finishes later.

Several independent tasks at once, or work the user wants done while they are away: hand off to the `wforge:crew` skill, which files them and runs the `wforge:crew` workflow under the same caps.

## 3. Tier table

| Step | Model | Effort | Agent |
|---|---|---|---|
| Plan, architecture, hard debugging, final review | opus | high | `wforge:planner`, `wforge:skeptic` |
| Implementation of a specified step | sonnet | medium | `wforge:builder` |
| Refute a finding, review one file | sonnet | low | `wforge:skeptic` |
| Search, listing, extraction, running a check, verifying a diff | haiku | low | `wforge:scout`, `wforge:checker` |
| Formatting, lint, tests, diff stats | no model | | Bash |

Fable only when the user names it. Never opus for search or checks. Never a fork subagent for something a fresh scout can answer.

## 4. Run it

- **S**: do it yourself now.
- **M**: spawn the subagents with the `model` and `effort` from the table, in parallel when independent. Give each one only the files and facts it needs.
- **L**: run the matching workflow with structured `args`:
  - new feature or multi-file change: `wforge:plan-build-verify` with `{ task }`
  - failing typecheck, lint or tests: `wforge:fix-until-green` with `{ check }`
  - review before merge: `wforge:review-changes` with `{ base }`
  - same change across many files: `wforge:migrate` with `{ instruction, glob }`
  Read the returned object; report branches to merge, failed checks and the skeptic's verdict to the user. Do not re-verify what the workflow already verified.
- **Bulk on the API lane**: run `"${CLAUDE_PLUGIN_ROOT}/bin/wforge-bulk" -m haiku "<task>"` in the background and continue. It refuses without an API key; then fall back to a haiku workflow.

## 5. Window rules

- `soft`: sonnet and haiku only, low effort on workers, workflows kept to one phase at a time.
- `hard`: no workflows, haiku subagents only. Do the current step inline, move bulk work to the API lane, or tell the user when the window resets and stop.
- The guard refuses more than the configured number of launches in ten minutes. If it refuses, finish what is running; do not retry the same call.

## 6. Report

End with what was built, what was verified and how, what is on which branch, and what the window looks like now. One short message.
