# Prior art: multi-agent coordination tools

Survey date: 2026-10-29. Audience: the two engineers building W-Comms.

Repos were shallow-cloned and read as data (nothing installed, built or run). `SP` below means the
a local scratch directory (clones not committed).
Tags: **[verified]** = read in source or primary docs. **[docs]** = vendor docs only, no code. **[inferred]** = my reading,
not confirmed. **[marketing]** = only third-party or marketing pages available.

## 1. Summary table

| Tool | OSS / licence | How agents communicate | Task / claim model | Memory / learning | Human-in-the-loop gates | Cross-machine? | Evidence |
|---|---|---|---|---|---|---|---|
| **Codeg** | Yes, Apache-2.0 | `delegate_to_agent` MCP tool (per-launch `codeg-mcp` companion, token-authed socket to a broker); `@agent` mentions | Work tasks `todo→queued→running⇄awaiting_input→review→merging→done`; `run_seq` generation + CAS | Session import/search across agents | Merge started by a user click or a user-queued merge; agent reports a verdict only | Self-host server, mobile, Telegram/Lark bridges (one owner) | `SP/codeg/src-tauri/src/acp/delegation/mod.rs`, `work_task/engine.rs` |
| **Amoeba** | No (proprietary; ToS forbids RE) | Shared "session" with one lane per person; comments on transcript/diff hunks | One plan per session; unowned steps claimable, started steps need owner's OK | "Brain": short notes pinned to files+commits, flagged stale on merge | Ownership is per person; every agent turn has a visible human sponsor | Yes (team SaaS, macOS app) | [docs] useamoeba.com/docs/concepts/workspaces, /docs/collaboration/live-sessions |
| **Bloome** | No | Agents are chat members; @mention to start | Not documented | "Memory scope" named, not described | Not documented | Yes (SaaS chat) | [marketing] bloome.im/features/ai-agent-platform |
| **Agent Orchestrator (Orchestrator.inc)** | Yes, Apache-2.0 | Orchestrator agent spawns workers; CI/review feedback routed back to owning worker | One agent+branch+worktree per task; lanes derived from PR/CI state | None specific found | Reviewer agents run in a capability gateway pinned to exact PR+commit | Local daemon; LAN/mobile listener | `SP/agent-orchestrator/docs/adr/0002-secure-interactive-reviewer-gateway.md`, `docs/scm-observer.md` |
| **MetaGPT** | Yes, MIT | Pub/sub environment: `publish_message`, roles `_watch` action types (`cause_by`), `send_to` addressing | SOP pipeline of roles (PM, architect, engineer, QA) | Per-role memory | None built in | No (single process) | `SP/MetaGPT/metagpt/roles/role.py:284,411`, `environment/base_env.py:175` |
| **AgentScope** | Yes, Apache-2.0 | Team pipeline: leader calls `TeamAssign` tool on members | SOP engine with per-step state and attempt budget | Skill loader | Permission engine; SOP "parks" (stream ends) when a person must answer, resumes from stored state | No | `SP/agentscope/src/agentscope/pipeline/_team_pipeline.py`, `sop/_engine.py`, `permission/` |
| **agentUniverse (PEER)** | Yes, Apache-2.0 | Fixed Plan→Execute→Express→Review agents | Loop retried until reviewer `score >= eval_threshold` | Datasets for fine-tuning roles | None (LLM reviewer is the gate) | No | `SP/agentUniverse/agentuniverse/agent/work_pattern/peer_work_pattern.py` |
| **Entire** | CLI: MIT; platform: proprietary | Hooks capture sessions; `entire review` runs reviewer profiles | Trails (branch-centric intent: draft/open/merged/closed) | Checkpoints: redacted transcripts linked to commits via `Entire-Checkpoint` trailer | Trails reportedly allow auto-merge on AI scores or require sign-off [marketing] | Yes (git refs + entire.io) | `SP/entire-cli/docs/architecture/sessions-and-checkpoints.md`, `claude-hooks-integration.md`, `cmd/entire/cli/trail/trail.go` |
| **GitHub Copilot custom agents** | No | `.github/agents/*.agent.md`; VS Code `handoffs` buttons | Issue assigned to agent → one branch, one PR per task | None | Output is a PR; rulesets/branch protection apply; handoffs default `send: false` | Yes (GitHub) | [docs] docs.github.com/.../create-custom-agents; code.visualstudio.com/docs/copilot/customization/custom-agents |
| **Hermes Agent kanban** | Yes, MIT | Task comments are "the inter-agent protocol"; parent results injected into child context | SQLite board, WAL + `BEGIN IMMEDIATE` + CAS on status/claim_lock; dispatcher every 60s | Skills/memory/curator (studied already); per-task pinned skills | `review` lane needs a reviewer; block/unblock by human; respawn guards | No ("single-host by design") | `SP/hermes-agent/hermes_cli/kanban_db.py`, `kanban_workflow.py`, `website/docs/user-guide/features/kanban.md` |
| **Claude Code agent teams / subagents** | No (product) | Mailbox JSON per agent `~/.claude/teams/{team}/inboxes/{agent}.json`; `SendMessage` | Shared task list, file-lock claims, dependencies auto-unblock | None team-level | `TaskCreated`/`TaskCompleted`/`TeammateIdle` hooks (exit 2 blocks); agent messages flagged as not-from-user | No (one session, one machine) | [docs] code.claude.com/docs/en/agent-teams |
| **Claude Squad** | Yes, AGPL-3.0 | None (tmux sessions) | One tmux session + git worktree per task | None | Human reviews diff before push; `--autoyes` optional | No | `SP/claude-squad/README.md` |
| **Conductor** | No | None between agents | Workspace (branch, files, terminal) per task | Not documented | Human reviews diff, opens PR, merges | No [docs] | [docs] conductor.build/docs |
| **Vibe Kanban** | Yes, Apache-2.0 (sunsetting) | None between agents; MCP server exposes issues/workspaces | Kanban issues → workspaces (branch+terminal) | None | Inline diff comments sent back to agent | Remote service ending; going local-only | `SP/vibe-kanban/crates/mcp/src`, vibekanban.com/blog/shutdown |
| **CrewAI** | Yes, MIT | Sequential or hierarchical (manager agent) process; `allow_delegation` | Tasks bound to agents | Unified memory with scopes; save path embeds, dedups, LLM-consolidates | `Task.human_input`, `guardrail(s)` validate output before next task | No | `SP/crewAI/lib/crewai/src/crewai/task.py:242-275`, `memory/encoding_flow.py` |
| **AG2 (ex-AutoGen)** | Yes, Apache-2.0 (+ MIT/CC-BY portions in `license_original/`) | `ag2.network`: hub + channels + JSON `Envelope` (audience, priority) persisted to per-channel WAL; typed adapters (consulting, discussion, workflow) | Channel expectations, e.g. `reply_within(600s)` then auto-close | Working/episodic memory policies | `ApprovalRequired` tool middleware (Y/N/Always per tool source) | Yes (ws transport) | `SP/ag2/ag2/network/envelope.py`, `adapters/consulting.py`, `middleware/builtin/tools/approval.py` |
| **OpenHands Agent Canvas** | Yes, MIT | Runs ACP agents across local/remote/cloud backends; automations | Automations (schedule/webhook), issue decomposition | Not assessed | Not assessed | Yes (backends) | `SP/OpenHands/README.md` (repo is now the Canvas front end; agent SDK not reviewed) |
| **MCP Agent Mail** | MIT **+ rider excluding Anthropic/OpenAI** | MCP server: `send_message`, `fetch_inbox(unread_only)`, threads, `ack_required`, FTS search | Advisory file reservations (TTL, exclusive), optional pre-commit/pre-push guard | Messages archived as markdown in git | "HumanOverseer" sender identity with preamble; contact policies | Yes (HTTP MCP) | `SP/mcp_agent_mail/README.md` §"How it works", §"Contact model", §"File Reservations" |
| **amutix / amux** | Yes, MIT (npm ships TS source) | File inboxes, discussions, `responseRequired` replies | `todo/assigned/in-progress/review/done/blocked` pure state machine; reservations tied to tasks | Journal (last 10 entries), ways-of-working | Reviewer role may mark `done` | No (local files) | `SP/amux/amutix-pkg/package/core/task-state-machine.ts`, `core/attention.ts`, `roles/reviewer.md`; REA output `SP/rea-out/amutix.json` |

## 2. Per-tool mechanisms

**Codeg** (spacering-net/codeg, Rust/Tauri + Next.js)
- Delegation is a function call. The parent calls MCP `delegate_to_agent`; a per-launch `codeg-mcp` binary forwards it over a token-authed UDS/named pipe to a `DelegationBroker`, which spawns a child ACP session, waits for its first `TurnComplete` and returns the child's final text as the tool result (`acp/delegation/mod.rs`). Default `depth_limit: 1` (`broker.rs:253`).
- `resume_delegation` revives only an *interrupted* child with the same call id. It cannot start a second iteration (`mod.rs` header).
- Work-task pipeline `todo → queued → running ⇄ awaiting_input → review → merging → done`. Every launch claims a new `run_seq` and events settle by CAS on `(connection_id, run_seq)`, so a cancel racing a late completion has no effect (`work_task/engine.rs:1-17`).
- Agents report through `task_progress` and `task_complete(verdict = success | needs_review | blocked, summary)`. `blocked` settles to failed and the others go to `review` (`engine.rs:3138-3175`, prompt at `:7346`).
- Merge is two-stage: base merges into the worktree first, then lands on base under a per-folder git mutex, with merge intent persisted for crash replay. It is started by a user click or a merge the user queued (`engine.rs:3765-3785`). An `auto` flag exists; I did not trace what it does **[inferred]**.

**Amoeba** (useamoeba.com) **[docs]**
- Overlap warnings compare branch, open file paths, *planned* file paths and task descriptions across live sessions. Exact-path locks are "advisory and scoped to the session, not a filesystem write barrier".
- Plan steps: unowned and unstarted steps can be claimed instantly; started steps need the current owner's consent.
- Comments attach to a session, a transcript moment, a file range or a diff hunk, and can be turned into plan steps or prompts. "Resolving never deletes." Comments on code that has since changed are labelled.
- Brain: short structured notes pinned to files and commits. When a merge changes the code a note points to, the note is flagged and the next agent working nearby rewrites it. Humans can edit or retire notes. No pre-approval step is documented.
- Work is assigned to people, not agents. Each agent turn has one visible sponsor, and the composer shows whose account will be used. Handoff/takeover passes the branch at last sync, the plan and fresh memories.
- ToS §02: "you may not reverse engineer it except where the law allows". REA was not used.

**Bloome** **[marketing]**
- Agents are chat members with a profile, a system prompt and selected tools. External agents (Claude Code, Codex) connect "via ACP". No approval, memory or reviewer mechanism is documented beyond marketing copy.

**Agent Orchestrator** (OrchestratorInc/agent-orchestrator, Go daemon + desktop)
- Board lanes (Working / Needs you / In review / Ready to merge) are *derived* from the agent, PR, CI and review state, not set by hand (README). An SCM observer polls PRs every 30s into SQLite tables `pr`, `pr_checks`, `pr_reviews`, `pr_review_threads` (`docs/scm-observer.md`).
- Failed checks and review comments are routed back to the worker that owns the branch (README).
- ADR-0002 reviewer gateway: each reviewer gets an immutable manifest binding it to exact review-run ids, the PR URL and base/target object ids. Source access is structured (pinned blob read, pinned diff). Side effects are limited to posting a review on *that* PR/commit. There is no arbitrary-shell primitive.

**MetaGPT** (FoundationAgents/MetaGPT)
- Roles subscribe by action type: `_watch([WritePRD])`, and `_observe` keeps messages where `cause_by in watch or name in send_to` (`roles/role.py:284,411`). The environment routes by `send_to` addresses (`environment/base_env.py:175-188`).
- Everything runs in one process with an SOP of fixed roles. Useful mainly as the "subscribe to message kinds, not channels" idea.

**AgentScope** (agentscope-ai/agentscope, v2 layout)
- The leader assigns through an external `TeamAssign` tool and each `TeamMember` carries a `description` the leader reads (`pipeline/_team_pipeline.py`).
- `SOPEngine`: "when something needs a person the stream simply ends — nothing stays suspended. Come back with the answer and it picks up from the state" (`sop/_engine.py`). This is a durable park/resume for human gates.
- The permission engine has rules, modes and `UserConfirmResultEvent` (`permission/`).

**agentUniverse PEER**
- `peer_work_pattern.py` loops planning → executing → expressing → reviewing up to `retry_count` times and stops when the reviewing agent's `score >= eval_threshold`. `jump_step` picks which stage to restart from. The reviewer is an LLM, so an LLM decides when work is done.

**Entire** (entireio/cli, Go, MIT)
- Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse[Agent]`, `PostToolUse[Agent]`, `PostToolUse[Skill]`) track sessions, files touched and subagent tasks (`docs/architecture/claude-hooks-integration.md`).
- Live session state is kept in `.git/entire-sessions/<id>.json`. On commit, a session condenses into a checkpoint (redacted transcript + metadata) stored on the orphan branch `entire/checkpoints/v1` and linked to the code commit by an `Entire-Checkpoint:` commit trailer (`sessions-and-checkpoints.md`). Redaction lives in `SP/entire-cli/redact/`.
- Trails are branch-centric intent records with status `draft|open|merged|closed` (`cmd/entire/cli/trail/trail.go`). They answer "why/what"; checkpoints answer "how/when".
- `entire review <profile> --target <branch|trail>` runs reviewer agents in a managed worktree and stores findings locally (`review-command.md`).
- Platform "Trails replaces PRs with AI quality scores; teams choose auto-merge or human sign-off" comes from launch press only **[marketing]**.

**GitHub Copilot custom agents** **[docs]**
- `.github/agents/<name>.agent.md` with frontmatter `name`, `description` (required), `tools`, `mcp-servers`, `model`, `target`, and a body of up to 30k chars. Org-level agents live in `.github`/`.github-private`.
- The coding agent works on one branch and opens one PR per task. Rulesets and branch protection can block it. "Logs do not replace your own review."
- In VS Code, `handoffs: [{label, agent, prompt, send}]` shows buttons after a response. `send: false` (the default in the example) makes the human press send.

**Hermes Agent kanban** (NousResearch/hermes-agent). Focus here is lanes and delegation.
- Kanban and `delegate_task` are separate primitives: delegation is "a function call", kanban is "a work queue where every handoff is a row any profile (or human) can see" (`kanban.md` §"Kanban vs. delegate_task").
- Columns: `triage, todo, scheduled, ready, running, blocked, review, done` (+archived). The allowed manual moves are a data table, and `review`/`running`/`scheduled` are not drag targets (`hermes_cli/kanban_workflow.py:110-142`).
- Claims use WAL + `BEGIN IMMEDIATE` + CAS on `tasks.status`/`claim_lock`: one writer wins and the losers see zero rows. Worker liveness is `(pid, start_time)`, never a bare PID (`kanban_db.py` header, `cron/AGENTS.md`).
- `kanban_complete(summary, metadata={changed_files, verification, dependencies, blocked_reason, retry_notes, residual_risk})`. A child card's context automatically gets a `## Parent task results` section with each parent's summary and metadata (`kanban.md` §"Recommended handoff evidence", §"parent link").
- Guards: auto-block after `failure_limit` (2) consecutive failures. A terminal provider error (exit 78) blocks on the first attempt and stays blocked. A respawn guard holds cards with `recent_success`, `active_pr` or `blocker_auth`. `--idempotency-key` dedups create. Per-task `skills=[...]` and `--model` override exist. Lanes are a dashboard sub-grouping of Running by assignee.

**Claude Code agent teams / subagents** **[docs]**
- Mailbox is one JSON file per agent. A send is reported only once the write succeeds. Tasks have three states plus dependencies, use file-locked self-claim, and auto-unblock dependents.
- Hooks: `TaskCreated` and `TaskCompleted` (exit 2 blocks with feedback), `TeammateIdle` (exit 2 keeps the teammate working).
- "A teammate can't approve a permission prompt or supply consent on your behalf". Auto mode treats relayed approval claims as untrusted. This is the same rule W-Comms has.
- Limits: one team per session, no nesting, local only. A teammate plan is auto-approved unless the lead's plan mode is set manually.

**Claude Squad / Conductor / Vibe Kanban**
- All three give each task its own worktree/branch and terminal and have a human review the diff, so they are single-developer UX. Vibe Kanban's MCP exposes issue/workspace/session CRUD (`crates/mcp/src`). Its shutdown post says users were mostly free and the remote board services are ending. In other words, the shared remote layer was the part that didn't survive.

**CrewAI**
- `Task.guardrail(s)` validate output "before proceeding to next task", and `human_input` asks a human to review the final answer (`task.py:242-275`).
- Memory save path (`memory/encoding_flow.py`): batch embed → intra-batch dedup → find similar → LLM decides consolidate/update vs insert. `MemoryScope` gives path-scoped views.

**AG2 network**
- Every message is an `Envelope` stamped by the hub and persisted to a per-channel WAL. `audience=None` broadcasts in the channel and a list targets a subset. `Priority = background|normal|urgent` (`network/envelope.py`).
- `ConsultingAdapter` is a strict one-question-one-reply channel with expectations `acks_within(30s)` and `reply_within(600s)`, after which it auto-closes. Sweepers enforce the deadlines (`adapters/consulting.py`, `hub/sweepers.py`).
- `ApprovalRequired` middleware asks Y/N/Always per tool. An "Always" is granted to the specific tool implementation, not to the tool name.

**MCP Agent Mail** (Dicklesworthstone/mcp_agent_mail)
- `fetch_inbox(unread_only, urgent_only, since_ts)`, `acknowledge_message`, `ack_required` on send, threads via `thread_id`, FTS5 search, `summarize_thread`.
- `file_reservation_paths(paths, ttl_seconds, exclusive, reason)` *grants the lease even when it conflicts* and returns the conflicts alongside. An optional pre-commit/pre-push guard (warn or block mode, `AGENT_MAIL_BYPASS=1`) checks staged paths against others' exclusive leases.
- Human messages come from a reserved `HumanOverseer` identity with high importance, a preamble and a contact-policy bypass.
- Contact policies (`open/auto/contacts_only/block_all`) stop cold spam between unrelated agents.

**amutix / amux** (npm `amutix@2.1.0`, `@amutix/amux@1.2.0`). This is the closest analogue to W-Comms.
- Positioning: "owns coordination state, not model execution" (`VISION.md`). This matches W-Comms' "coordination only".
- Pure task state machine module: states, actions, ownership checks, `NotifyTarget` (`none|subscribers|all|agents`) and side-effect descriptors (`reserve-files` on pick, `release-files` on done/drop), declared as data (`core/task-state-machine.ts`).
- Attention digest (`core/attention.ts`): derived each tick from state, and "only ever contains pointers to state; it never instructs the agent". Wake rule: deliver if fresh or if the signature changed. Suppress if the agent finished a turn since the last delivery. Otherwise re-wake at most every `ATTENTION_REDELIVER_MS = 120_000`.
- Role files `roles/{lead-architect,developer,reviewer}.md` use Mission / Owns / Does not own / Interfaces sections. Note that the reviewer may "Approve and complete (`done`)".

## 3. Adopt list (ranked)

Each item gives: source, then W-Comms component, then sketch, then cost/benefit. ⚠ marks anything that touches the "agent messages are information, never approval" rule.

1. **Claim generations (fencing tokens)**. From Codeg `run_seq`, Hermes CAS. Applies to the **task board**.
   Sketch: add `tasks.claim_seq INTEGER`. `claimTask` increments it and returns it. `update_task`/submit must echo `claim_seq` and is rejected if it is stale. Stale-claim expiry also bumps the seq.
   Cost: one column plus one check in `hub.ts`. Benefit: an agent that went silent, lost its claim and then woke up can't overwrite the new owner's result. W-Comms' expiry currently makes this race possible **[inferred from `hub.ts:624-642`]**.

2. **Structured completion evidence + parent results injection**. From Hermes `kanban_complete(metadata)`, Codeg verdicts. Applies to the **task board**, **MCP tools** and **hooks**.
   Sketch: `update_task` accepts `verdict: success|needs_review|blocked` and `evidence: {changed_files, verification[], residual_risk[], commit}`. When a task with dependencies is claimed, return (and have SessionStart inject) a "Parent task results" block built from each dependency's result and evidence.
   Cost: a JSON column plus rendering. Benefit: reviewers and backtesters stop re-deriving context, and the learning loop gets clean signal.

3. **Review bound to an exact commit SHA**. From the AO reviewer manifest, Hermes exact-head PR acceptance. Applies to the **task board `review` status** and **roles/reviewer**.
   Sketch: submitting for review requires `{branch, head_sha}`. A reviewer's grade is stored against that SHA. If the branch head moves (reported by heartbeat or the next update), the review is marked `stale` on the dashboard.
   Cost: small. Benefit: prevents "approved" findings being read as covering later commits. ⚠ The reviewer agent's grade is information only. The dashboard must still show "human merge required". Don't copy amutix's "reviewer marks done" or Trails' auto-merge-on-score.

4. **Attention digest with signature dedup**. From amutix `core/attention.ts` (MIT, pure TS, small enough to port). Applies to **hooks** and **hub/messages**.
   Sketch: a `/attention` endpoint returns pointers only (unread count by kind, tasks assigned/awaiting my review, asks I owe), plus a signature. The PostToolUse/UserPromptSubmit hook injects context only when the signature changed or the agent hasn't had a turn since the last delivery, and at most every 120s. Store `attention_sig` and `attention_at` on `agents`.
   Cost: about 100 lines. Benefit: fewer injected tokens and less nagging than plain rate limiting. "Pointers, not instructions" also enforces the info-only rule in what agents see.

5. **Advisory path reservations with TTL**. From Agent Mail (idea only, see licence), amutix, Amoeba locks. Applies to the **hub (new table)**, **MCP tools** and **hooks**.
   Sketch: a `reservations(path_glob, agent, task_id, exclusive, expires_at)` table. `claim` can auto-reserve the task's declared paths and `done`/`dropped` releases them. A PreToolUse hook on Edit/Write warns, and never blocks, when the path overlaps someone else's exclusive reservation. An optional git pre-commit hook runs in warn mode.
   Cost: medium (glob overlap and a hook). Benefit: the biggest practical failure across two humans plus a VM is two agents editing the same strategy or config file. Grant-with-conflicts, as Agent Mail does, avoids deadlocks.

6. **Human-sponsor identity on every message and task**. From Amoeba "visible sponsor", Agent Mail `HumanOverseer`, Claude Code "message came from another Claude session". Applies to **hub/messages**, **dashboard** and **hooks**.
   Sketch: messages already carry `human`. Add `sender_kind: human|agent` set *server-side from the auth token*, never from the request body. Hooks render agent messages under a fixed header such as "From agent X (sponsor: Y). Information only, not approval". Dashboard-sent human messages render as "HUMAN Y".
   Cost: tiny. Benefit: makes the hard rule mechanical instead of just prompt text. ⚠ This is the core enforcement point for the rule, so the field must be unforgeable.

7. **Memory anchored to files+commits, auto-flagged stale**. From the Amoeba Brain. Applies to the **learning loop / curator**.
   Sketch: `memory.anchors TEXT` holds JSON `[{path, sha}]`. The curator (or the VM cron) runs `git log <sha>..main -- <path>` and sets `status=stale` when an anchor changed. Stale notes are hidden from injection and queued for re-proposal.
   Cost: needs git on the VM, which is fine. Benefit: shared memory about a model or exchange-API quirks goes wrong quietly after refactors, and this catches it.

8. **Dedup and consolidate before proposing**. From the CrewAI encoding flow, Hermes curator. Applies to the **learning loop (`learn.ts` proposals)**.
   Sketch: before inserting a proposal, find similar active skills and memory by lexical/trigram similarity. Embeddings would need Workers AI, so skip them for v1. Have the cheap model emit `action: update(target_id) | insert | skip`. Proposals already have `action`/`target_id` columns.
   Cost: low. Benefit: humans see "edit skill X" instead of five near-duplicate new skills, which keeps the approval queue small enough that people actually work through it.

9. **Commit trailers linking work to tasks + transcript redaction**. From Entire `Entire-Checkpoint` trailer and `redact/`. Applies to **hooks** and the **learning loop**.
   Sketch: a `prepare-commit-msg` hook in repo-kit appends `W-Comms-Task: T123` and `W-Comms-Agent: <id>` when the agent has an active claim. `wcomms-learn.py` runs a secret-pattern redaction pass (API keys, exchange creds, `.dev.vars`-style lines) before sending transcripts to the cheap model.
   Cost: low. Benefit: the dashboard can link task → commits, the curator can tell which skills preceded merged work, and redaction is cheap insurance for a trading repo.

10. **Failure circuit breaker on tasks**. From Hermes `failure_limit`, terminal-error sticky block, respawn guard. Applies to the **task board**.
    Sketch: count consecutive `blocked`/expired claims per task. At 2, set `status=blocked` with `last_failure` and require a human to unblock from the dashboard.
    Cost: tiny. Benefit: stops the cloud VM agent re-claiming a task that keeps failing (for example a missing API key) all night.

11. **Task-pinned skills and model hint**. From Hermes `kanban_create(skills=[...])` and per-task model override. Applies to **roles** and the **task board**.
    Sketch: optional `tasks.skills` and `tasks.model_hint`. `claim`'s response and the SessionStart hook list them ("load skill backtest-walkforward"). There's no runtime install: the skills must already be synced into `.claude/skills/`.
    Cost: tiny. Benefit: connects the learning loop's approved skills to the work that needs them. It also lets the planner (frontier model) keep coders and backtesters on cheaper models.

12. **"Ask" messages with reply deadline**. From the AG2 `ConsultingAdapter reply_within`, Agent Mail `ack_required`. Applies to **hub/messages** and the **dashboard**.
    Sketch: `kind=ask` with `reply_by` and `thread_id`. Attention (item 4) lists asks I owe. The dashboard shows overdue asks, and when the deadline passes the asker gets a "no reply" note.
    Cost: low. Benefit: agents on different machines stop blocking indefinitely on each other. ⚠ An `ask` answered by an agent never satisfies a human-approval need. Questions like "may I deploy?" must be routed to `recipient=human:<name>` only, and the hub should reject `ask` to agents when `topic` is `deploy|merge|live`.

Lower priority but cheap: an idempotency key on `create_task` for cron/VM automation (Hermes), and `TaskCompleted`-style refusal of `done` without `evidence.verification` for the coder role (Claude Code hooks).

## 4. Skip list

- **Process spawning, dispatchers and orchestrator agents that launch workers** (Hermes dispatcher, AO orchestrator, Codeg `delegate_to_agent`, Claude Code teams). W-Comms coordinates agents that humans start on their own machines, and remote spawning on a teammate's laptop crosses the coordination-only boundary. Local subagents already cover in-session delegation.
- **LLM-score-gated completion or merge** (agentUniverse PEER `score >= eval_threshold`, Entire Trails auto-merge, amutix reviewer → `done`, Copilot `send: true` handoffs, Claude Code auto-approved teammate plans). These directly conflict with the hard rule. A reviewer grade stays advisory.
- **Git-backed message and checkpoint stores** (Agent Mail markdown archive, Entire orphan branches). They would put coordination noise into the trading repo, and the Durable Object is already durable and versioned.
- **In-process orchestration frameworks** (MetaGPT SOP, AgentScope pipelines, AG2 group-chat speaker selection, CrewAI crews). They assume one Python process owns every agent. Only their ideas transfer (items 8 and 12).
- **Contact and consent policies** (Agent Mail). These are for many unrelated agents. With about 5 roles on one repo, topics and direct messages are enough.
- **Embedding-based memory** (CrewAI). Embeddings add a Workers AI dependency and cost for a corpus of maybe a few hundred notes. Revisit if lexical dedup misses.
- **Real-time shared sessions and lanes** (Amoeba lanes, Bloome group chat, Claude Squad/Conductor/Vibe Kanban UIs). These need transcript streaming and a heavy client. The dashboard plus hooks gets 80% of the value. Vibe Kanban's shutdown, with remote services ending first, is a warning against building a big hosted UI.
- **Auto-decomposition into a task graph without review** (Hermes `kanban decompose`). Fine as planner *proposals*, which should land as `triage` tasks a human promotes. Don't auto-promote them to ready.
- **Derived PR/CI lanes** (AO SCM observer). Nice to have, but it needs GitHub polling. Defer until merges go through PRs that W-Comms can see.

## 5. Licence notes (code reuse, not ideas)

| Source | Licence | Reuse verdict |
|---|---|---|
| amutix / amux (`core/attention.ts`, `task-state-machine.ts`) | MIT | **Reusable**: pure TS with no I/O, close to drop-in for the Worker. Keep the MIT notice in a header comment. |
| Hermes Agent (`kanban_workflow.py` transition table) | MIT | Reusable with notice. It's Python, so in practice we'd port it, and the notice still applies to a close translation. |
| Entire CLI (`redact/` patterns, hook docs) | MIT | Reusable with notice. Go, so port the regex list. |
| MetaGPT, CrewAI, OpenHands Agent Canvas | MIT | Reusable with notice. Little we'd copy. |
| Codeg, AgentScope, agentUniverse, Agent Orchestrator, Vibe Kanban | Apache-2.0 | Reusable. Keep LICENSE/NOTICE, mark modified files, and note the patent-termination clause. |
| AG2 | Apache-2.0, plus MIT (Microsoft AutoGen) and CC-BY-4.0 portions in `license_original/` | Reusable. Check which licence covers a given file before copying. |
| Claude Squad | AGPL-3.0 | **Do not copy.** Network-use copyleft would reach our hosted Worker. |
| MCP Agent Mail | MIT + rider: no rights to Anthropic, OpenAI or anyone acting "for the benefit of" them, and "use" includes executing/analysing in ML pipelines | **Do not copy code or run it.** The rider's scope is broad and unclear for a Claude-agent workflow (legal reading not verified). Ideas (reservations, ack_required) are not copyrightable and are used here from the README only. |
| Amoeba, Conductor, Bloome, Copilot, Claude Code, Entire platform | Proprietary | Ideas from public docs only. Amoeba ToS forbids reverse engineering. |

## 6. Method notes and gaps

- **REA**: `rea-agents@6.8.0` `analyze-javascript-application` was run on the published npm package `amutix@2.1.0`, fetched with `npm pack` and extracted, never installed. Output is at `SP/rea-out/amutix.json` (40 MB). It parsed 31 JS/TS files with 0 failures and reported 0 IPC channels, browser windows or native addons, so the package is a local-only CLI with no network surface. It added nothing beyond reading the shipped TypeScript, which isn't minified. It also warned about an unsupported engine (it needs Node ≥22.23.4 and we have 22.20) but ran anyway. It was not used on Amoeba (ToS forbids RE), Conductor, Bloome or Copilot (closed, nothing public to analyse), or Codeg/Vibe Kanban (full source available).
- **Not assessed in depth**: Bloome (marketing only), Conductor (docs index only), OpenHands' agent SDK (the cloned repo is now the Agent Canvas front end), and Entire's hosted Trails merge policy (press only). The Amoeba summary is from its docs, not the product.
- "GitHub topics/multi-agent Agent-Orchestrator" was read as OrchestratorInc/agent-orchestrator (cloned via the ComposioHQ URL, which now serves this repo; ownership history [inferred]). Other repos with that name were not surveyed.
