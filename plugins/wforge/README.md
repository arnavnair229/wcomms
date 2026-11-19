# wforge

An add-on to [wcomms](../../README.md): wcomms coordinates the people and agents on a repo; wforge makes one builder's own sessions cheaper and safer to fan out.

Budget-aware build orchestration for Claude Code. The right model for each step, a hard cap on fan-out, and a guard that keeps you inside your 5-hour and weekly windows.

wforge is a Claude Code plugin, not a separate harness. Inference runs in your own Claude Code on your own subscription, or on your own API key through the Agent SDK. Nothing is proxied, no credentials are collected.

## What it does

- **Tiered models.** Opus plans and reviews, Sonnet builds, Haiku searches and checks, scripts run the tests. Five subagent definitions carry the tiers so ad-hoc delegation lands on the right model too.
- **Four workflows** with caps baked in: `plan-build-verify`, `fix-until-green`, `review-changes`, `migrate`. Each runs as a dynamic workflow in the background and returns one structured result.
- **A usage guard.** A status-line bridge records the 5-hour and 7-day windows locally. A PreToolUse hook reads them before every subagent or workflow launch: above the soft threshold it downshifts the model and effort, above the hard threshold it blocks fan-out, and it refuses more than N launches in any ten minutes. A rate-limit error from the API records a lockout until the reset.
- **An API lane.** `wforge-bulk` and `sdk/wforge_api.py` run the same plugin on `ANTHROPIC_API_KEY`, so bulk work costs the window nothing. Max, Ultra and Team plans include monthly API credits for exactly this.

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
  workflows/                   the four orchestration scripts
  skills/                      forge, budget, setup
  hooks/                       guard (PreToolUse), session (SessionStart), lockout (StopFailure)
  bin/                         wforge-statusline, wforge-usage, wforge-setup, wforge-bulk
  sdk/wforge_api.py            Agent SDK runner for the API lane
  reference/tiers.md           why the tiers are what they are
  tests/                       hook and bridge tests, run with tests/run.sh
```

State lives in `~/.claude/wforge/` (or under `CLAUDE_CONFIG_DIR`): the usage snapshot, a lockout marker and per-session launch counters.

## Policy

Anthropic's Claude Code terms allow an end user to sign in to the unmodified Claude Code binary with their own subscription, and expect products built on the Agent SDK to use API keys. wforge follows both: the plugin runs inside your Claude Code, and the API lane requires a key. It never spawns headless Claude Code on a plan login, which is also metered at a higher rate.

## License

MIT, with wcomms.
