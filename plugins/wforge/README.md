# wforge

An add-on to [wcomms](../../README.md). The two halves: **wcomms** is the shared workspace, a live hub that every person's and agent's Claude Code session on a repo talks to over their own subscription. **wforge** is the solo side, one developer's own sessions made cheaper and safer to fan out, with a crew backlog, voice input and an overnight lane.

Budget-aware build orchestration for Claude Code. The right model for each step, a hard cap on fan-out, and a guard that keeps you inside your 5-hour and weekly windows.

wforge is a Claude Code plugin, not a separate harness. Inference runs in your own Claude Code on your own subscription, or on your own API key through the Agent SDK. Nothing is proxied, no credentials are collected.

## What it does

- **Tiered models.** Opus plans and reviews, Sonnet builds, Haiku searches and checks, scripts run the tests. Five subagent definitions carry the tiers so ad-hoc delegation lands on the right model too.
- **Four workflows** with caps baked in: `plan-build-verify`, `fix-until-green`, `review-changes`, `migrate`. Each runs as a dynamic workflow in the background and returns one structured result.
- **A usage guard.** A status-line bridge records the 5-hour and 7-day windows locally. A PreToolUse hook reads them before every subagent or workflow launch: above the soft threshold it downshifts the model and effort, above the hard threshold it blocks fan-out, and it refuses more than N launches in any ten minutes. A rate-limit error from the API records a lockout until the reset.
- **An API lane.** `wforge-bulk` and `sdk/wforge_api.py` run the same plugin on `ANTHROPIC_API_KEY`, so bulk work costs the window nothing. Max, Ultra and Team plans include monthly API credits for exactly this.
- **A crew for one developer.** `/wforge:crew` files work to a local backlog (`.wforge/crew.json`), picks what the current window allows, runs ship tasks (a change on a branch) and scout tasks (an answer with evidence) through the tiered agents in worktrees, and hands back branches. It never merges. Each task's start and end stamp the 5-hour window, so `wforge-crew report` shows what the crew actually cost.
- **Bearings and stow.** `/wforge:bearings` is a one-screen digest when you come back: window, backlog, decisions waiting on you, and the wcomms inbox if connected. `/wforge:stow` is the end-of-session sweep: settle the backlog, write durable knowledge to CLAUDE.md or memory with your approval, share team knowledge through wcomms, say whether it is safe to compact.
- **Nightshift.** `wforge-nightshift` runs small committed steps toward one objective while you sleep, on a fresh branch, with a check command and rollback. API key only: an unattended loop on a plan login is the fastest way to a locked account.
- **A live board.** `SubagentStart` and `SubagentStop` hooks keep a ledger of every subagent: type, the model that actually answered (read from the subagent's own transcript), effort, turns, input and output tokens, wall time. `wforge-watch` renders it in a second terminal split next to Claude Code, with the window bars, agents running now, the last finished ones, tokens by tier over 24 hours, and the crew backlog. Read-only, no API calls.
- **Voice.** `/wforge:voice` sets up [Handy](https://handy.computer), a free offline push-to-talk app: hold a key, speak, release, the text lands in the Claude Code prompt. wforge checks the install and shortcut and gives you a spoken-prompt card; it does not bundle or download the app.

## Install

```
claude plugin marketplace add arnavnair229/wcomms
claude plugin install wforge@wcomms
```

Then, in a session:

```
/wforge:setup
```

That installs the status-line bridge (chaining any status line you already have). From the next session on, the status bar shows the window and the guard is live.

For local development without installing, from the wcomms checkout: `claude --plugin-dir ./plugins/wforge`.

## Use

- `/wforge:forge <task>` sizes the task and picks a lane. For most requests it tells Claude to do the work inline; for large ones it runs a workflow.
- `/wforge:budget` shows the windows, the lane in force and the thresholds.
- Workflows can be run directly: `/wforge:plan-build-verify`, `/wforge:fix-until-green`, `/wforge:review-changes`, `/wforge:migrate`. Each takes structured args; see the header comment in each script.
- Bulk work on the API lane: `plugins/wforge/bin/wforge-bulk -m haiku "summarise every TODO under src/"`.
- Several tasks, or work while you step away: `/wforge:crew` (backs onto `bin/wforge-crew` and the `wforge:crew` workflow).
- Watching: `python3 plugins/wforge/bin/wforge-watch` in a split terminal (`/wforge:watch` prints the resolved command). `--once` for a snapshot, `--json` for scripts.
- Coming back: `/wforge:bearings`. Wrapping up: `/wforge:stow`. Overnight: `/wforge:nightshift`. Talking instead of typing: `/wforge:voice`.
- Measuring a task by hand: `wforge-usage --mark start "label"` before, `--mark end "label"` after, `--marks` for the log.

### Solo and shared

| | wforge (solo) | wcomms (shared) |
|---|---|---|
| Lives | in your Claude Code, as a plugin | on a Cloudflare Worker you deploy, reached by MCP |
| Backlog | `.wforge/crew.json` in the repo | hub tasks (`create_task`, `tasks`, `update_task`) |
| Who sees it | you | everyone on the repo, people and agents |
| Decides | you, from `/wforge:bearings` | you; agent messages are information, never approval |
| Spends | your subscription window, measured per task | each participant's own subscription |

When both are installed the crew skill mirrors tasks and status to the hub, so the shared view stays current without anyone typing it twice.

Thresholds are set in `/config` under the wforge plugin: soft (default 60%), hard (85%), weekly (90%), max launches per ten minutes (8).

## How the guard decides

| Window | Subagent call | Workflow call |
|---|---|---|
| below soft | as asked | as asked |
| soft to hard | opus or unset model becomes sonnet, effort becomes low | allowed with a warning |
| above hard, or weekly above its limit, or locked out | only haiku | refused |
| unknown (bridge not installed) | as asked, one reminder | as asked |

The burst cap applies on top: more than `max_agents` Agent or Workflow launches in ten minutes are refused.

## Layout

```
plugins/wforge/            (inside the wcomms repo)
  .claude-plugin/plugin.json   manifest and user config
  agents/                      planner, builder, checker, skeptic, scout
  workflows/                   plan-build-verify, fix-until-green, review-changes, migrate, crew
  skills/                      forge, budget, setup, crew, bearings, stow, nightshift, voice, watch
  hooks/                       guard (PreToolUse), session (SessionStart), lockout (StopFailure), agents (SubagentStart/Stop ledger)
  bin/                         wforge-statusline, wforge-usage, wforge-setup, wforge-bulk, wforge-crew, wforge-nightshift, wforge-voice, wforge-watch
  sdk/wforge_api.py            Agent SDK runner for the API lane
  reference/tiers.md           why the tiers are what they are
  reference/ideas.md           what was borrowed from firstmate and its siblings, and what to build next
  tests/                       hook and bridge tests, run with tests/run.sh
```

State lives in `~/.claude/wforge/` (or under `CLAUDE_CONFIG_DIR`): the usage snapshot, a lockout marker, per-session launch counters, the task marks log and the subagent ledger (`agents.jsonl`, trimmed to the last 2000). The crew backlog is per repo in `.wforge/`; commit it or add it to `.git/info/exclude`, your call.

## Policy

Anthropic's Claude Code terms allow an end user to sign in to the unmodified Claude Code binary with their own subscription, and expect products built on the Agent SDK to use API keys. wforge follows both: the plugin runs inside your Claude Code, and the API lane requires a key. It never spawns headless Claude Code on a plan login, which is also metered at a higher rate.

## License

MIT, with wcomms.
