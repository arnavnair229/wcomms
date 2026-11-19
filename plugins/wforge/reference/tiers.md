# Why these tiers

The point of wforge is cost per finished task, not cost per request. The rules below are the ones that moved that number in practice; everything else in the plugin exists to enforce them.

## Model per step

| Step | Model | Reason |
|---|---|---|
| Planning, architecture, final review | opus, high effort | One careful pass here saves rounds of rework below. It is also the one place a single context should hold the whole problem. |
| Implementing a specified step | sonnet, medium | Once the files, behaviour and check are named, a mid-tier model does the edit reliably and for a fraction of the window. |
| Refuting a finding, reviewing one file | sonnet, low | Verification needs judgment but not depth; low effort means fewer tool calls and a shorter answer. |
| Search, listing, extraction, running checks | haiku, low | These are lookups. The expensive models do not find files faster. |
| Lint, typecheck, tests, diff stats | none | Deterministic. A script step in the workflow, never an agent. |

Fable is never chosen by the plugin. Users who want it say so.

## Why the window drains

Three things empty a 5-hour window in twenty minutes:

1. **Fan-out at the top tier.** Ten opus subagents reading a codebase each pay the full context load. The guard's burst cap and the workflow size caps exist for this.
2. **Headless runs on the plan login.** `claude -p` and Agent SDK sessions signed in with a subscription are metered at roughly twice the interactive rate per token (outside measurement, not Anthropic's figure). wforge never spawns `claude -p` on the subscription; the bulk lane refuses to run without an API key.
3. **Forks.** A forked subagent inherits the whole conversation. At the soft threshold the guard lets them through with a warning; at hard it refuses them.

## Lanes

| Lane | Runs on | Cost to the window | Use for |
|---|---|---|---|
| Interactive session | subscription | normal | planning, review, small builds |
| Subagents and workflows in that session | subscription | normal, multiplied by agent count | M and L tasks within the caps |
| `wforge-bulk`, `wforge_api.py` | API key | none | bulk mechanical work, long reads, scheduled jobs |

Max ($100), Ultra ($200) and Team (pooled) plans include monthly API credits that cover the API lane when the key comes from the Console organization linked to the plan. Pro includes none.
