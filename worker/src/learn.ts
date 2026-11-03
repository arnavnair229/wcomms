// The learning loop: shared skills (procedural memory), a small always-loaded shared memory, and the
// human-gated proposal queue that feeds both. Patterned on Hermes Agent's skills + memory + curator,
// with one change: nothing an agent proposes reaches other agents until a human approves it.
import { HubError, ROLES, ago, keywords, trunc } from "./util";

export const MEMORY_BUDGET = 2200;
const MAX_MEMORY_ENTRY = 400;
const MAX_SKILL_BODY = 12_000;
const STALE_DAYS = 14;
const ARCHIVE_DAYS = 30;
const DAY = 86_400_000;
export const SKILL_PREFIX = "wc-";

export const LEARN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL, approved_by TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS skill_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, version INTEGER NOT NULL,
    description TEXT NOT NULL, body TEXT NOT NULL, approved_by TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created_by TEXT NOT NULL,
    approved_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS skill_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, agent TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS skill_usage_name ON skill_usage (name, ts)`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, action TEXT NOT NULL, name TEXT, target_id INTEGER,
    description TEXT, body TEXT, rationale TEXT, flags TEXT, source TEXT NOT NULL, proposed_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, review_note TEXT,
    created_at INTEGER NOT NULL, reviewed_at INTEGER)`,
];

export type Skill = {
  name: string; description: string; body: string; version: number; status: string; pinned: number;
  created_by: string; approved_by: string; use_count: number; last_used_at: number | null;
  created_at: number; updated_at: number; roles: string[]; usage: Record<string, number>;
};
type SkillRow = Omit<Skill, "roles" | "usage"> & { roles: string | null };
export type Proposal = {
  id: number; kind: "skill" | "memory"; action: string; name: string | null; target_id: number | null;
  description: string | null; body: string | null; rationale: string | null; flags: string[]; roles: string[];
  source: string; proposed_by: string; status: string; reviewed_by: string | null; review_note: string | null;
  created_at: number; reviewed_at: number | null;
};
export type MemoryEntry = { id: number; body: string; created_by: string; approved_by: string; created_at: number };

type Bind = string | number | null;
type Who = { id: string; human: string };
type Announce = (m: { sender: string; human: string; recipient: string; topic: string; kind: string; body: string }) => number;

/** Cheap red flags shown next to a proposal in the dashboard. Advisory: the human still decides. */
const SCANS: [RegExp, string][] = [
  [/curl[^\n|]*\|\s*(ba|z)?sh|wget[^\n|]*\|\s*(ba|z)?sh/i, "pipes a download into a shell"],
  [/ignore (all |any )?(previous|prior|above) (instructions|rules)/i, "tries to override instructions"],
  [/(treat|take|follow).{0,40}(messages?|posts?) from (other )?agents.{0,30}(as )?(instructions|approval|orders)/i, "treats agent messages as instructions"],
  [/\b(api[_-]?key|secret|password|bearer)\b\s*[:=]\s*\S{8,}/i, "contains something that looks like a credential"],
  [/[​-‏‪-‮⁦-⁩]/, "contains hidden unicode"],
  [/[A-Za-z0-9+/]{160,}={0,2}/, "contains a long encoded blob"],
  [/\brm\s+-rf\s+[~/]/, "deletes from / or ~"],
  [/\b(deploy|live[- ]trad|place (an )?order|git push --force|merge (in)?to main|production|prod db|drop table)/i, "mentions a gated action (deploy / merge / production / money): check it keeps the human in the loop"],
];

export function scan(text: string): string[] {
  return SCANS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const USAGE_DAYS = 30;
const RETAG_MIN_USES = 5;
const RETAG_MIN_SHARE = 0.25;

/** Comma list of roles, validated. undefined = not given (keep existing); null = none. */
function normRoles(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(",")).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  for (const r of list) if (!ROLES.includes(r)) throw new HubError(`roles must be from: ${ROLES.join(", ")} (got "${r}")`);
  return list.length ? [...new Set(list)].join(",") : null;
}
const splitRoles = (s: string | null | undefined) => (s ? s.split(",").filter(Boolean) : []);
/** The role suffix of an agent id like login@machine-session-coder, if any. */
export const roleOf = (agent: string) => { const last = agent.split("-").pop() ?? ""; return ROLES.includes(last) ? last : null; };

function overlap(a: string, b: string): number {
  const x = keywords(a);
  const y = keywords(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

export class Learning {
  constructor(private sql: SqlStorage, private announce: Announce) {}

  private rows<T>(q: string, ...b: Bind[]): T[] {
    return this.sql.exec(q, ...b).toArray() as T[];
  }

  private row<T>(q: string, ...b: Bind[]): T | undefined {
    return this.rows<T>(q, ...b)[0];
  }

  private decode = (p: Proposal): Proposal => ({ ...p, flags: JSON.parse((p.flags as unknown as string) || "[]"), roles: splitRoles(p.roles as unknown as string) });

  // ---------- proposals ----------

  propose(a: Who, args: Record<string, any>, source = "agent"): Proposal {
    const kind = String(args.kind || "");
    if (kind === "skill") return this.proposeSkill(a, args, source);
    if (kind === "memory") return this.proposeMemory(a, args, source);
    throw new HubError('kind must be "skill" or "memory"');
  }

  private proposeSkill(a: Who, args: Record<string, any>, source: string): Proposal {
    let action = String(args.action || "create");
    const name = String(args.name || "").toLowerCase().replace(new RegExp(`^${SKILL_PREFIX}`), "");
    if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) throw new HubError("skill name must be kebab-case, 2-48 chars");
    if (!["create", "patch", "archive"].includes(action)) throw new HubError("skill action must be create, patch or archive");
    const existing = this.row<SkillRow>("SELECT * FROM skills WHERE name = ?", name);
    if (action === "create" && existing && existing.status !== "archived") action = "patch";
    if (action !== "create" && !existing) throw new HubError(`no skill ${SKILL_PREFIX}${name}; use action=create`);

    const description = args.description ? String(args.description).trim() : existing?.description ?? "";
    const body = args.body ? String(args.body).trim() : action === "archive" ? null : existing?.body ?? "";
    if (action !== "archive") {
      if (!description || description.length > 300) throw new HubError("description is required, max 300 chars: say when to use the skill");
      if (!body) throw new HubError("body is required: the full SKILL.md body (procedure, pitfalls, verification)");
      if (body.length > MAX_SKILL_BODY) throw new HubError(`body max ${MAX_SKILL_BODY} chars; split it or move detail into linked repo files`);
    }

    const givenRoles = normRoles(args.roles);
    const roles = givenRoles === undefined ? existing?.roles ?? null : givenRoles;
    const flags = scan(`${description}\n${body ?? ""}`);
    if (action === "create") {
      for (const s of this.rows<SkillRow>("SELECT name, description, body FROM skills WHERE status != 'archived'")) {
        if (overlap(`${name} ${description}`, `${s.name} ${s.description}`) >= 0.6) flags.push(`may duplicate ${SKILL_PREFIX}${s.name}: consider a patch instead`);
      }
    }
    const rationale = args.rationale ? trunc(String(args.rationale), 500) : null;

    // One pending proposal per skill: a newer proposal replaces the older one rather than piling up.
    const pending = this.row<Proposal>("SELECT * FROM proposals WHERE kind = 'skill' AND name = ? AND status = 'pending'", name);
    if (pending) {
      this.sql.exec(
        "UPDATE proposals SET action = ?, description = ?, body = ?, rationale = ?, flags = ?, roles = ?, source = ?, proposed_by = ?, created_at = ? WHERE id = ?",
        action, description, body, rationale, JSON.stringify(flags), roles, source, a.id, Date.now(), pending.id,
      );
      return this.proposal(pending.id);
    }
    return this.insert(a, { kind: "skill", action, name, description, body, rationale, flags, roles, source });
  }

  private proposeMemory(a: Who, args: Record<string, any>, source: string): Proposal {
    const action = String(args.action || "add");
    const rationale = args.rationale ? trunc(String(args.rationale), 500) : null;
    if (action === "remove") {
      const id = Number(String(args.target_id ?? "").replace(/^M/, ""));
      if (!this.row("SELECT id FROM memory WHERE id = ?", id)) throw new HubError(`no memory entry M${id}`);
      return this.insert(a, { kind: "memory", action, target_id: id, rationale, flags: [], source });
    }
    if (action !== "add") throw new HubError("memory action must be add or remove");
    const body = String(args.body ?? "").trim().replace(/\s+/g, " ");
    if (!body) throw new HubError("body is required");
    if (body.length > MAX_MEMORY_ENTRY) throw new HubError(`memory entries max ${MAX_MEMORY_ENTRY} chars; a long procedure belongs in a skill`);
    const near = [...this.memory(), ...this.rows<MemoryEntry>("SELECT id, body FROM proposals WHERE kind = 'memory' AND status = 'pending' AND body IS NOT NULL")]
      .find((m) => norm(m.body) === norm(body) || overlap(m.body, body) >= 0.8);
    if (near) throw new HubError(`already covered: "${trunc(near.body, 120)}"`, 409);
    return this.insert(a, { kind: "memory", action, body, rationale, flags: scan(body), source });
  }

  private insert(a: Who, p: { kind: string; action: string; name?: string; target_id?: number; description?: string; body?: string | null; rationale: string | null; flags: string[]; roles?: string | null; source: string }): Proposal {
    const { id } = this.row<{ id: number }>(
      `INSERT INTO proposals (kind, action, name, target_id, description, body, rationale, flags, roles, source, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      p.kind, p.action, p.name ?? null, p.target_id ?? null, p.description ?? null, p.body ?? null,
      p.rationale, JSON.stringify(p.flags), p.roles ?? null, p.source, a.id, Date.now(),
    )!;
    const what = p.kind === "skill" ? `${p.action} skill ${SKILL_PREFIX}${p.name}${p.roles ? ` (${p.roles})` : ""}` : `${p.action} memory`;
    this.announce({
      sender: a.id, human: a.human, recipient: "humans", topic: "learning", kind: "note",
      body: `proposal P${id}: ${what}${p.rationale ? `. ${trunc(p.rationale, 200)}` : ""} (review it on the dashboard)`,
    });
    return this.proposal(id);
  }

  proposal(id: number): Proposal {
    const p = this.row<Proposal>("SELECT * FROM proposals WHERE id = ?", id);
    if (!p) throw new HubError(`no proposal P${id}`, 404);
    return this.decode(p);
  }

  proposals(status = "pending"): Proposal[] {
    return status === "all"
      ? this.rows<Proposal>("SELECT * FROM proposals ORDER BY id DESC LIMIT 100").map(this.decode)
      : this.rows<Proposal>("SELECT * FROM proposals WHERE status = ? ORDER BY id DESC LIMIT 100", status).map(this.decode);
  }

  /** Human decision on a proposal. Approval applies it. Only reachable with an admin token. */
  decide(id: number, human: string, approve: boolean, note?: string): Proposal {
    const p = this.proposal(id);
    if (p.status !== "pending") throw new HubError(`P${id} is already ${p.status}`, 409);
    const now = Date.now();
    if (approve) this.apply(p, human, now);
    this.sql.exec(
      "UPDATE proposals SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?",
      approve ? "approved" : "rejected", human, note ? trunc(note, 300) : null, now, id,
    );
    return this.proposal(id);
  }

  private apply(p: Proposal, human: string, now: number) {
    const tell = (body: string) => this.announce({ sender: human, human, recipient: "all", topic: "learning", kind: "note", body });
    if (p.kind === "memory") {
      if (p.action === "remove") {
        this.sql.exec("DELETE FROM memory WHERE id = ?", p.target_id);
        return;
      }
      const used = this.memoryUsed();
      if (used + p.body!.length > MEMORY_BUDGET) {
        throw new HubError(`shared memory is at ${used}/${MEMORY_BUDGET} chars; this entry needs ${p.body!.length}. Remove or shorten entries first.`, 409);
      }
      this.sql.exec("INSERT INTO memory (body, created_by, approved_by, created_at) VALUES (?, ?, ?, ?)", p.body, p.proposed_by, human, now);
      tell(`shared memory updated (approved by ${human}): ${trunc(p.body, 200)}`);
      return;
    }
    const s = this.row<SkillRow>("SELECT * FROM skills WHERE name = ?", p.name);
    const roles = p.roles.length ? p.roles.join(",") : null;
    if (p.action === "archive") {
      this.sql.exec("UPDATE skills SET status = 'archived', updated_at = ? WHERE name = ?", now, p.name);
      return;
    }
    const version = (s?.version ?? 0) + 1;
    if (s) {
      this.sql.exec(
        "UPDATE skills SET description = ?, body = ?, version = ?, status = 'active', roles = ?, approved_by = ?, updated_at = ? WHERE name = ?",
        p.description, p.body, version, roles, human, now, p.name,
      );
    } else {
      this.sql.exec(
        `INSERT INTO skills (name, description, body, version, roles, created_by, approved_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        p.name, p.description, p.body, roles, p.proposed_by, human, now, now,
      );
    }
    this.sql.exec(
      "INSERT INTO skill_history (name, version, description, body, approved_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      p.name, version, p.description, p.body, human, now,
    );
    tell(`skill ${SKILL_PREFIX}${p.name} v${version} approved by ${human}${roles ? ` (preloaded for ${roles})` : ""}: ${trunc(p.description, 160)}. New sessions pick it up automatically.`);
  }

  // ---------- skills ----------

  /** Uses per skill per role over the last 30 days: the learned edges of the skill graph. */
  usageByRole(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const r of this.rows<{ name: string; role: string | null; n: number }>(
      "SELECT name, role, COUNT(*) AS n FROM skill_usage WHERE ts > ? GROUP BY name, role", Date.now() - USAGE_DAYS * DAY)) {
      (out[r.name] ??= {})[r.role ?? "main"] = r.n;
    }
    return out;
  }

  private decodeSkill(usage: Record<string, Record<string, number>>) {
    return (s: SkillRow): Skill => ({ ...s, roles: splitRoles(s.roles), usage: usage[s.name] ?? {} });
  }

  skills(includeArchived = false): Skill[] {
    const rows = includeArchived
      ? this.rows<SkillRow>("SELECT * FROM skills ORDER BY status, name")
      : this.rows<SkillRow>("SELECT * FROM skills WHERE status != 'archived' ORDER BY name");
    return rows.map(this.decodeSkill(this.usageByRole()));
  }

  skill(name: string, history = false) {
    const row = this.row<SkillRow>("SELECT * FROM skills WHERE name = ?", name.replace(new RegExp(`^${SKILL_PREFIX}`), ""));
    if (!row) throw new HubError(`no skill ${name}`, 404);
    const s = this.decodeSkill(this.usageByRole())(row);
    return history ? { ...s, history: this.rows("SELECT version, description, approved_by, updated_at FROM skill_history WHERE name = ? ORDER BY version DESC LIMIT 20", s.name) } : s;
  }

  /** Files for clients to write into .claude/skills/. Claude Code loads them with progressive disclosure. */
  bundle() {
    return this.skills().map((s) => ({
      dir: SKILL_PREFIX + s.name,
      version: s.version,
      roles: s.roles,
      content:
        `---\nname: ${SKILL_PREFIX}${s.name}\ndescription: ${JSON.stringify(s.description)}\n` +
        `metadata:\n  wcomms-version: "${s.version}"\n  roles: ${JSON.stringify(s.roles)}\n---\n\n${s.body}\n\n` +
        `<!-- wcomms-managed skill v${s.version}, approved by ${s.approved_by}${s.roles.length ? `, preloaded for ${s.roles.join(", ")}` : ""}. Do not edit here: propose changes with the wcomms propose_skill tool. -->\n`,
    }));
  }

  used(name: string, agent: string) {
    const n = name.replace(new RegExp(`^${SKILL_PREFIX}`), "");
    if (!this.row("SELECT name FROM skills WHERE name = ?", n)) return { ok: false };
    const now = Date.now();
    this.sql.exec(
      "UPDATE skills SET use_count = use_count + 1, last_used_at = ?, status = CASE WHEN status = 'stale' THEN 'active' ELSE status END WHERE name = ?",
      now, n,
    );
    this.sql.exec("INSERT INTO skill_usage (name, role, agent, ts) VALUES (?, ?, ?, ?)", n, roleOf(agent), agent, now);
    return { ok: true, role: roleOf(agent) };
  }

  setSkill(name: string, op: string) {
    const s = this.skill(name);
    const sets: Record<string, string> = {
      pin: "pinned = 1", unpin: "pinned = 0", archive: "status = 'archived'", restore: "status = 'active', last_used_at = ?",
    };
    if (!sets[op]) throw new HubError("op must be pin, unpin, archive or restore");
    if (op === "restore") this.sql.exec(`UPDATE skills SET ${sets[op]} WHERE name = ?`, Date.now(), s.name);
    else this.sql.exec(`UPDATE skills SET ${sets[op]} WHERE name = ?`, s.name);
    return this.skill(s.name);
  }

  // ---------- memory ----------

  memory(): MemoryEntry[] {
    return this.rows<MemoryEntry>("SELECT * FROM memory ORDER BY id");
  }

  memoryUsed(): number {
    return this.row<{ n: number }>("SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM memory")!.n;
  }

  deleteMemory(id: number) {
    this.sql.exec("DELETE FROM memory WHERE id = ?", id);
    return { ok: true };
  }

  // ---------- curator ----------

  /** Deterministic pruning, like Hermes's curator minus the LLM pass: unused skills go stale, then archive. */
  curate(now = Date.now(), force = false) {
    const changed: string[] = [];
    for (const s of this.rows<SkillRow>("SELECT * FROM skills WHERE pinned = 0 AND status IN ('active', 'stale')")) {
      const idle = now - (s.last_used_at ?? s.created_at);
      const next = idle > ARCHIVE_DAYS * DAY ? "archived" : idle > STALE_DAYS * DAY ? "stale" : s.status;
      if (next !== s.status) {
        this.sql.exec("UPDATE skills SET status = ? WHERE name = ?", next, s.name);
        changed.push(`${SKILL_PREFIX}${s.name} -> ${next}`);
      }
    }
    if (changed.length) {
      this.announce({ sender: "wcomms", human: "wcomms", recipient: "humans", topic: "learning", kind: "system", body: `curator: ${changed.join(", ")} (unused). Restore from the dashboard if needed.` });
    }
    changed.push(...this.proposeRetags(now));
    void force;
    return changed;
  }

  /**
   * The learned graph in action: when a role keeps using a skill it isn't preloaded for, propose adding that role.
   * Humans approve it like any other proposal, and a rejection is respected for 30 days.
   */
  private proposeRetags(now: number): string[] {
    const out: string[] = [];
    const usage = this.usageByRole();
    for (const s of this.rows<SkillRow>("SELECT * FROM skills WHERE status = 'active'")) {
      const byRole = usage[s.name];
      if (!byRole) continue;
      const total = Object.values(byRole).reduce((a, b) => a + b, 0);
      const current = splitRoles(s.roles);
      const add = ROLES.filter((r) => !current.includes(r) && (byRole[r] ?? 0) >= RETAG_MIN_USES && byRole[r] / total >= RETAG_MIN_SHARE);
      if (!add.length) continue;
      const roles = [...current, ...add].join(",");
      if (this.row("SELECT id FROM proposals WHERE kind = 'skill' AND name = ? AND status = 'pending'", s.name)) continue;
      if (this.row("SELECT id FROM proposals WHERE kind = 'skill' AND name = ? AND source = 'curator' AND roles = ? AND status = 'rejected' AND reviewed_at > ?", s.name, roles, now - 30 * DAY)) continue;
      const why = add.map((r) => `${r} used it ${byRole[r]}× in ${USAGE_DAYS} days (${Math.round((byRole[r] / total) * 100)}% of uses)`).join("; ");
      this.insert({ id: "wcomms", human: "wcomms" }, {
        kind: "skill", action: "patch", name: s.name, description: s.description, body: s.body,
        rationale: `Preload for ${add.join(", ")}: ${why}.`, flags: [], roles, source: "curator",
      });
      out.push(`${SKILL_PREFIX}${s.name}: proposed preloading for ${add.join(", ")}`);
    }
    return out;
  }

  // ---------- text for agents ----------

  banner(): string[] {
    const out: string[] = [];
    const mem = this.memory();
    if (mem.length) out.push(`Shared memory [${this.memoryUsed()}/${MEMORY_BUDGET}]:`, ...mem.map((m) => `  - ${m.body} (M${m.id})`));
    const skills = this.skills();
    const pending = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'")!.n;
    if (skills.length || pending) {
      out.push(`Shared skills (${SKILL_PREFIX}*, synced into .claude/skills; preloaded for the roles in brackets): ${skills.map((s) => SKILL_PREFIX + s.name + (s.roles.length ? ` [${s.roles.join(",")}]` : "")).join(", ") || "none yet"}` +
        `${pending ? ` | ${pending} proposal(s) awaiting human review` : ""}`);
    }
    return out;
  }

  /** What the background reviewer needs to avoid duplicates: existing skills and memory. */
  reviewContext(): string {
    const skills = this.skills();
    return [
      `SHARED MEMORY [${this.memoryUsed()}/${MEMORY_BUDGET} chars]:`,
      ...(this.memory().map((m) => `- M${m.id}: ${m.body}`) || []),
      "",
      "EXISTING SHARED SKILLS:",
      ...skills.map((s) => `### ${s.name} (v${s.version}, roles: ${s.roles.join(", ") || "none"}, used ${s.use_count}x, last ${ago(s.last_used_at ?? s.created_at)} ago)\n${s.description}\n${trunc(s.body, 1500)}`),
      ...(skills.length ? [] : ["(none)"]),
      "",
      "PENDING PROPOSALS:",
      ...this.proposals().map((p) => `- P${p.id} ${p.kind} ${p.action} ${p.name ?? ""}: ${trunc(p.description ?? p.body ?? "", 160)}`),
    ].join("\n");
  }

  fmtProposal(p: Proposal): string {
    const what = p.kind === "skill" ? `${p.action} ${SKILL_PREFIX}${p.name}${p.roles.length ? ` (roles: ${p.roles.join(", ")})` : ""}` : `memory ${p.action}${p.target_id ? ` M${p.target_id}` : ""}`;
    return `P${p.id} [${p.status}] ${what}${p.flags.length ? ` (flags: ${p.flags.join("; ")})` : ""}`;
  }
}
