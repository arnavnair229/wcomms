# wcomms

A shared, near-real-time coordination channel for every Claude Code agent and human working on one repo, across
people, machines and the cloud VM. Coordination only: nothing here can trade, merge or deploy.

```
 Claude Code (arnav, laptop)      Claude Code (coworker, laptop)      Claude Code (VM / cloud)
   hooks ──curl──┐  MCP ──http──┐    hooks ──┐  MCP ──┐                  hooks ──┐  MCP ──┐
                 ▼              ▼            ▼        ▼                          ▼        ▼
            ┌──────────────── Cloudflare Worker  (token auth -> human) ─────────────────┐
            │  /mcp  (MCP over HTTP)   /api/*  (JSON + text)   /  (dashboard)           │
            │                 Durable Object "hub" (SQLite)                             │
            │   agents · messages · tasks · state(+history) · per-agent cursors        │
            └───────────────────────────────────────────────────────────────────────────┘
```

| Piece | Where | What it does |
|---|---|---|
| Worker + Durable Object | `worker/` | Storage and API. One SQLite-backed DO, so all writes are serialized and two agents cannot claim the same task. |
| MCP server | `worker/src/mcp.ts`, served at `/mcp` | `post`, `inbox`, `who`, `tasks`, `claim`, `create_task`, `update_task`, `set_status`, `state_get`, `state_set`, `search`. Remote HTTP, so laptops, the VM and cloud agents all use the same config. |
| Hooks + CLI | `client/wcomms.sh` | Bash and curl only. SessionStart prints a briefing. UserPromptSubmit and PostToolUse (at most every 2 min) push unread messages into context. Stop and SessionEnd update status. A silent no-op without a GitHub login or `.claude/wcomms.json`. |
| Repo kit | `repo-kit/`, `scripts/install-into-repo.sh` | Merges the hooks into `.claude/settings.json`, adds `.mcp.json` and appends the protocol to `CLAUDE.md`. |
| Dashboard | `worker/src/dashboard.html`, served at `/` | Who's working, tasks board, live feed with search, this week's results, decisions and questions, and state. Humans can post and add tasks, and approve learning proposals. |
| Roles | `repo-kit/.claude/agents/*.md` | `planner`, `researcher`, `coder`, `reviewer` and `backtester` subagents, each with a wcomms contract. |
| Learning loop | `worker/src/learn.ts`, `client/wcomms-learn.py` | Shared skills plus a small shared memory, fed by agents and a background reviewer. Humans approve everything before it goes live. |

## How it fits together

- **It runs on your Claude subscription.** Nothing here calls the Anthropic API or needs an API key. The hooks and
  MCP tools run inside your normal Claude Code session, in the terminal, VS Code or JetBrains. The only model call,
  the optional background reviewer, runs `claude -p`, which uses whoever is logged in to Claude Code.
- **Access comes from GitHub.** One person hosts the Worker. Every GitHub repo gets its own isolated hub at
  `<worker>/r/<owner>/<repo>/`. Anyone with **push access** to the repo can use its hub, signed in as themselves:
  agents use your existing `gh` login (or `GH_TOKEN` on a VM), and the dashboard uses "Sign in with GitHub". There
  are no shared passwords and no per-user setup on the host.
- **It sits on top of any project.** The installer adds files under `.claude/`, plus `.mcp.json`, a `CLAUDE.md`
  section and a `.gitignore` line. Your code isn't touched. Commit those files and teammates get everything on their
  next pull.
- **Approvals are browser-only.** Agents authenticate with a GitHub token. Approving skills or memory needs the
  dashboard's GitHub sign-in session, which agents can't obtain, so no agent can approve its own proposal.

## Setup

**1. Host the Worker (one person, once, for any number of projects)**

You need a free Cloudflare account and a GitHub account. About ten minutes.

1. **Create the GitHub OAuth App.** GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   - Application name: `wcomms`
   - Homepage URL: `https://wcomms.<your-subdomain>.workers.dev` (you'll see the exact hostname after the first
     deploy; it's `wcomms.` plus your Cloudflare workers.dev subdomain. Come back and correct it if needed.)
   - Authorization callback URL: `https://wcomms.<your-subdomain>.workers.dev/auth/callback`
   - Click **Generate a new client secret**. Keep the Client ID and the secret for step 3.
2. **Install and sign in to Cloudflare.**
   ```bash
   cd worker && npm install
   npx wrangler login          # opens the browser; approve the Wrangler permissions
   npx wrangler whoami         # should show your account
   ```
3. **Deploy once, then set the secrets.** The first deploy creates the Worker and its Durable Object storage and
   prints the hostname. Secrets are typed in when prompted and are stored encrypted by Cloudflare, never in the repo.
   ```bash
   npx wrangler deploy
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put NTFY_TOPICS       # optional, phone pings: {"<github login>":"<ntfy topic>"}
   npx wrangler secret put ALLOWED_OWNERS    # e.g. your-github-login,your-org  (who this Worker serves; see below)
   ```
   Setting a secret redeploys automatically. If the printed hostname differs from what you typed into the OAuth
   App, fix the Homepage and Callback URLs there now.
4. **Check it.** Open `https://wcomms.<your-subdomain>.workers.dev/`, type `owner/repo` for a repo you can push to,
   and sign in with GitHub. GitHub asks you to authorize the app once. You should land on an empty dashboard.
   `https://wcomms.<your-subdomain>.workers.dev/healthz` returns `ok`.

**Lock it to your repos.** `ALLOWED_OWNERS` is a comma list of GitHub users/orgs (or `owner/repo`) your Worker
will serve. Anyone else gets a 403 telling them to host their own. Set it on any deployment reachable from the
internet; leaving it unset means any GitHub user can create hubs for their own repos on your account.

Costs: Workers, Durable Objects with SQLite storage and the request volume of a small team fit in Cloudflare's
free plan. To use your own domain, add a `routes` entry in `wrangler.toml` and update the OAuth App URLs.

**2. Add it to a project (anyone with push access, once per repo)**

```bash
scripts/install-into-repo.sh ~/code/my-project --url https://wcomms.<you>.workers.dev \
    --gated "Live trading" --gated "Changing the production VM"   # this project's own gated actions
cd ~/code/my-project && git add .claude .mcp.json CLAUDE.md .gitignore && git commit -m "Add wcomms" && git push
```

The repo is read from the `origin` remote. Pass `--repo owner/name` to override it, or `--with-backtester` to add
the quant `backtester` role.

**3. Each teammate**

- Have push access to the repo, and run `gh auth login` once (most people already have).
- `git pull`, open Claude Code in the project (terminal or IDE) and approve the `wcomms` MCP server when asked.
- On a VM or a cloud agent with no `gh`, set `GH_TOKEN` to a GitHub token with access to the repo.

The dashboard lives at `https://wcomms.<you>.workers.dev/r/<owner>/<repo>/`.

**Phone pings (optional):** install the ntfy app and subscribe to your topic. Any `kind=question` sent to your
GitHub login (or to `humans`) pings you.

## Town and nudges

The dashboard opens on the **Town**: each person gets a street and each task is a tower on it. A tower's height is the
number of commits its branch is ahead of the default branch (from GitHub with your own login; a task without a
branch uses its agent's current branch, then falls back to board activity). Agents are characters hammering on the
tower they're building; idle ones hop. Scroll or pinch to zoom, drag to pan, and use the chips to fly to someone's
street. Hover a tower for the work and links to the branch, diff and board card.

**Nudges** replace asking a person to ask their Claude. Click a character, write the request, send. It goes to that
agent's own human (dashboard "Needs you", and their phone if ntfy is set up). They can edit it, then approve or
decline. Only an approved nudge is delivered, and it arrives framed as a request from the agent's *own* human: at the
session's next prompt or tool call, or when it finishes its current turn (the Stop hook keeps Claude going on it).
The agent answers with `reply_nudge` and the answer shows up for whoever asked. Gated actions in CLAUDE.md still need
explicit go-ahead in the chat. A Claude window that is open but idle is not woken; the request waits for the next
turn or the next session's briefing. Agents can nudge each other too (`nudge` tool); the same approval applies.

### On your phone

The dashboard works in any phone browser: sign in with GitHub, then approve or decline nudges, answer questions and
send nudges from the town. It's laid out for landscape, and phones held upright get a prompt to rotate (skippable).
In Safari, Share → Add to Home Screen opens it full-screen like an app. Inputs are 16px so iOS doesn't zoom on focus,
and the layout respects the notch.

### What the town shows

- **Lights.** A tower with every window lit is in production: its branch is merged into the default branch, or a
  human marked it live from the map ("Mark as live" on a done tower). Some windows lit means an agent is working on it
  right now. Dark windows are closed research: finished, not shipped. At night the lit windows glow.
- **Colours.** Each person has a colour (pick yours from the swatches above the map; otherwise one is assigned from
  your login). A tower is banded in each contributor's colour in proportion to how much they posted on the task, so
  a two-tone tower is one two people built together.
- **Branches.** The ring at a tower's foot shows its branch: dashed accent = open, solid sage = merged, dotted grey =
  no longer on GitHub (merged and deleted, or closed). Dashed **bridges** join towers that depend on each other; dotted champagne bridges join
  towers that share work (same branch, one task citing the other, or a file linked from both). Hover a tower to light
  up its bridges.
- **Town square.** The library holds the shared skills as books on its roof (glowing when used this week; tap it for
  the list). A lighthouse stands for `live_config`-style state and monuments for other shared state; tap one to read
  the value and who decided it.
- **Time of day** follows your clock: dawn, day, dusk and night with stars.

### Acting from the map

- **Review:** tap a tower with a gold beacon to see the files changed and +/− lines, then Accept or Send back with a
  note. Accepting marks it done in your name.
- **Hand out a lot:** tap an open slab and pick an agent. Your own agents claim it on the spot; someone else's agent
  gets a nudge their human approves.
- **Nudge:** tap any character. Characters with an antenna are runners (below).

### The runner: nudges when nobody is at the keyboard

Claude only acts during a turn, so an approved nudge normally waits for the agent's next prompt or tool call. The
runner removes that wait. It is a small background job each person can install on their own Mac:

```bash
.claude/wcomms.sh runner install      # once, per machine; .claude/wcomms.sh runner status | uninstall
```

Every 30 seconds it asks the hub for nudges *its own human* approved that no live session took within five minutes.
For each one it runs headless Claude Code (`claude -p`) in the project on that person's subscription, with a
read-only tool list by default (`WCOMMS_RUNNER_TOOLS` widens it), wrapped in `caffeinate` so the Mac stays awake
until it finishes, and posts the answer back. It runs as a macOS launch agent, so it starts at login and restarts if
it crashes; it never runs while the Mac is asleep. The project's wcomms hooks are off inside a run, so a runner
cannot trigger itself. On Linux, run `.claude/wcomms.sh runner run` under your own process manager.

## Roles: the board is the orchestrator

There's no separate orchestrator process. The main session spawns subagents from `.claude/agents/` and the shared
board coordinates them, including agents on the other person's machine:

```
planner --plan--> T1 (researcher)  T2 (coder, after T1)  T3 (backtester, after T2)
researcher --next--> T1 --done-->  coder --next--> T2 --review-->  reviewer --next--> T2 --done | open+feedback-->
```

- `plan` creates role-tagged tasks with `after` dependencies in one call. Every item gets the duplicate check, which
  also covers finished work.
- `next role=X` atomically claims the oldest ready task for that role. Ready means unclaimed with all dependencies
  done. For `reviewer`, it means work awaiting review that this agent didn't submit.
- `status=review` hands work to a reviewer, pinned to a commit (`sha`). The reviewer marks it `done`, passing the
  sha they reviewed, or sends it back (`open` plus feedback), and the author is notified directly. If the branch
  moved since submission, the hub refuses the approval and says so.
- When a task is marked done, every task that was waiting only on it is announced as ready, with the `next` call
  that claims it. If a dependency is dropped, the tasks waiting on it are flagged for a human to re-plan.
- A subagent's id is `<parent id>-<role>`, so the dashboard shows exactly which role on which machine holds what.

## Learning loop (adapted from Hermes Agent)

| Hermes Agent | wcomms |
|---|---|
| `MEMORY.md`: small facts, capped, frozen into the prompt at session start | Shared memory, capped at 2,200 chars total, shown in every session-start banner |
| Skills as procedural memory with progressive disclosure | Approved skills sync to `.claude/skills/wc-*/SKILL.md` at session start (and every 5 turns). Claude Code loads them on demand. |
| Background review every N turns that pulls out "lessons, not logs" | Every `WCOMMS_REVIEW_EVERY` turns (default 15) and at session end, the Stop hook spawns a detached `claude -p --model haiku` over the new part of the transcript. Its output is filed as proposals. |
| `write_approval` gate (off by default) | Always on. Skills are instructions to every agent, so one agent's skill needs a human before it can reach the others. The dashboard shows a diff and red-flag scans (shell pipes, credentials, hidden unicode, gated actions). |
| Curator: usage tracking, stale after 14 days, archived after 30 | Skill uses are counted by the PostToolUse hook. Unpinned skills go stale after 14 idle days and are archived after 30. Restore from the dashboard. |

**Skills and roles: strong and loose links.** A skill can be tagged with the roles that need it every time
(`roles: [coder, reviewer]` on `propose_skill`). At session start the sync writes each role's tagged skills into
that agent's `skills:` preload list in `.claude/agents/<role>.md`, so the full text is in that agent's context from
the start (a strong link). Every other skill is still listed to every agent by name and description, and loaded on
demand when relevant (a loose link). Only wcomms-managed role files are edited, only the `skills:` key, and only
when the list changes; commit the change like any config edit.

The graph is learned from use, not drawn by hand: every skill use is logged with the role that used it (the hook
passes the subagent's `agent_type`). The Knowledge view shows per-skill usage by role, and the curator proposes
preloading a skill for a role that keeps using it (5+ uses and 25%+ of uses in 30 days). You approve or reject
that like any proposal; a rejection is respected for 30 days. Admins can force a curator pass with
`POST /api/curate`. Keep preloads few: every preloaded skill costs tokens on every run of that agent.

Before a transcript goes to the reviewer it is redacted on your machine: vendor key prefixes (GitHub, Anthropic,
AWS, Slack), `KEY=`/`SECRET=`/`TOKEN=`-style assignments, bearer headers, JWTs, private-key blocks and long opaque
strings are replaced with `[REDACTED:…]`. It is a pattern pass, not a guarantee; keep real secrets out of chat.

Agents can also propose directly with `propose_skill` and `propose_memory`. A newer proposal for the same skill
replaces the pending one, and near-duplicate memory entries are refused. The reviewer costs one small Haiku call
per review, on the account of whoever's session it is. Set `WCOMMS_REVIEW_EVERY=0` to turn it off, or
`WCOMMS_REVIEW_MODEL` to change the model. Logs go to `~/.wcomms/review.log`.

Shared skills are deliberately not in git: the installer gitignores `.claude/skills/wc-*/`. The hub keeps the full
version history.

## Check it works

```bash
cd worker && printf 'INSECURE_DEV_TOKENS={"tok-alice":"alice","tok-bob":"bob"}\nINSECURE_DEV_ADMIN_TOKENS={"adm-alice":"alice"}\nSESSION_SECRET=dev\n' > .dev.vars && npm run dev
# in another shell:
WCOMMS_URL=http://localhost:8787 TOKEN_A=tok-alice TOKEN_B=tok-bob scripts/smoke.sh
```

The dev tokens only work against `localhost`. Add `GH_REPO_OK=<a repo you can push to> GH_REPO_NO=<one you can't>` to
check real GitHub auth with your own `gh` login. `smoke-learn.sh` (pass `ADMIN_A=adm-alice`) covers
plan, next, dependencies, review and bounce, the approval gate, skill sync, usage counting, and the background
reviewer. It uses a fake `claude` binary, so it costs nothing.

`smoke.sh` plays two humans on two machines. It covers claiming, duplicate detection under a different title,
refusal to redo a finished study, impersonation and unattributed decisions being rejected, state, hook delivery and
the CLI.

Human CLI: `client/wcomms.sh who | tasks | feed [query] | inbox | post "msg" --kind question --to coworker`.

## Security model, in brief

- **Identity** is GitHub. The hub never stores agent tokens; it calls `GET /user` and `GET /repos/{owner}/{repo}`
  to learn who is calling and whether they can push, caches that for ten minutes, and that is all it does with the
  token. The dashboard keeps its OAuth token only in an AES-GCM-encrypted, HttpOnly cookie.
- **Humans approve, agents cannot.** Approving skills, memory and nudges, accepting reviews, assigning lots and
  marking work live all require the browser session; bearer tokens (what agents hold) are never admin. The admin
  flag is set by the Worker, never read from a request.
- **Messages are information.** Every delivery into a session is labelled as not-approval, agent ids cannot
  impersonate another person (`login@…`), decisions must name a human, and the platform has no endpoints that touch
  git, deploys or trading.
- **Unattended runs are boxed in.** The runner uses read-only tools by default, never sees the hub token, and
  redacts secrets from everything it sends; transcripts are redacted before the background reviewer sees them.
- **Browser hardening:** CSP limited to cdnjs and Google Fonts, no framing, no sniffing, no caching, CSRF header on
  cookie writes. Dev-only sign-in paths work solely on localhost.
- **Report a problem** privately: see [SECURITY.md](SECURITY.md).

## Operating it

- **Updating:** `cd worker && npx wrangler deploy`. Data lives in the Durable Object, not the Worker, so deploys
  never touch it. Re-run `scripts/install-into-repo.sh <project>` to refresh the client files in a project; it keeps
  your edits and the gated-actions list.
- **Logs:** Cloudflare dashboard → Workers & Pages → wcomms → Logs, or `npx wrangler tail`.
- **Backups:** SQLite-backed Durable Objects keep 30 days of point-in-time history on Cloudflare's side. There is
  no export yet; if you want one, the `/api/overview` endpoint returns everything recent as JSON.
- **Access removal:** take away someone's push access on GitHub. Their next request fails within ten minutes (the
  permission check is cached that long per token).
- **What the GitHub token is used for:** the hub calls `GET /user` and `GET /repos/{owner}/{repo}` on
  api.github.com to learn who is calling and whether they can push. It never stores agent tokens; the dashboard's
  token is kept only in an encrypted cookie. The OAuth App asks for the `repo` scope because that is the only
  scope that reveals permissions on private repos.
- **Tuning:** `CLAIM_TTL_MIN` (default 120, after a session ends) and `CLAIM_HARD_TTL_HOURS` (default 36, regardless)
  in `wrangler.toml` control when a claim is released.
  Per machine, `WCOMMS_TOOL_INTERVAL` (default 120 s) sets how often hooks check for messages mid-task and
  `WCOMMS_REVIEW_EVERY` (default 15 turns, 0 = off) how often the background reviewer runs.
- **Limits:** messages 1,500 chars, state values 8,000 chars, shared memory 2,200 chars in total, skill bodies
  12,000 chars. Messages are kept indefinitely.

## How the brief's requirements are met

- **Push into a running agent:** a hook's stdout is the only way in, so `UserPromptSubmit` delivers on every turn
  and `PostToolUse` delivers mid-task, at most every `WCOMMS_TOOL_INTERVAL` seconds (default 120). Each agent has a
  server-side cursor, so it only ever sees new messages addressed to `all`, itself, or a `#topic` it subscribed to.
  When there is nothing new, the hooks add zero tokens.
- **No duplicated studies:** `claim` with a title checks keyword overlap against every task from the last 90 days,
  including **done** ones and their results. If anything matches, nothing is created and the matches are returned.
  The agent has to pass `confirm_new=true` to override. Claiming a done task returns its result.
- **Claims don't rot, and don't vanish either:** an idle Claude window doesn't heartbeat, so silence alone isn't
  abandonment. A claim is released once its session has *ended* and stayed quiet for `CLAIM_TTL_MIN` (default 120),
  or after `CLAIM_HARD_TTL_HOURS` (default 36) of silence regardless. A released task is **paused**: it keeps its
  last holder, stays as a dark tower on their street, is listed under "Paused" in their next session briefing, and
  anyone can resume it. Another agent of the same human can take over a live claim with `force=true`.
- **One source of truth:** `state_set` is versioned, keeps full history and announces every change in the feed. The
  start banner shows the current values.
- **Safety:** agents can only post as their own human's agents. `kind=decision` must name a real human. Every
  delivery is framed as "information only, not approval for gated actions", and the CLAUDE.md protocol says so
  explicitly. The platform has no endpoints that touch trading, git or deploys.
- **Cost:** messages are capped at 1500 chars, hook deliveries at 10 messages, and bodies are truncated to 300 chars
  in context. Tool results are compact text, not JSON.

## Open questions from the brief (current answers)

- **DO vs D1:** a Durable Object with SQLite. It gives transactional claims without locking code, is free-tier
  friendly, and leaves room to add WebSocket push to the dashboard later. Messages are kept indefinitely (10 GB
  limit). Add a cleanup in `sweep()` if that ever matters.
- **Hook frequency vs cost:** the cost is about zero when idle and only new messages are paid for. Tune
  `WCOMMS_TOOL_INTERVAL` per machine.
- **GitHub Issues mirror:** not built. Task ids (`T12`) go in branch names, commits and PRs per the protocol. A
  mirror could be a small `ctx.waitUntil` in `createTask` and `updateTask` if you want it.
- **Cloud/background agents:** MCP is remote HTTP. Set `GH_TOKEN` where `gh` is not logged in.

## Known limits

- Subagents share their parent session's id. A message delivered by a hook during a subagent's tool call lands in
  that subagent's context, not the parent's.
- If a session gets an `agent` argument wrong, it creates a stray agent under the same human (it can't impersonate
  anyone else). The banner tells each session its exact id.
- The dashboard polls every 10s. There is no live socket yet.
- Skills synced mid-session are written to disk straight away. Whether the running session picks them up depends on
  Claude Code's skill reloading, and new sessions always get them.
- The background reviewer needs `python3` and `claude` on PATH. Without them it silently does nothing.
