// Data for the dashboard's town scene: tasks as towers whose height is the number of commits their branch is ahead
// of the default branch. Commit counts come from GitHub with the viewer's own token, cached briefly per branch.
import { gh } from "./auth";

type Cached = { v: unknown; exp: number };
const cache = new Map<string, Cached>();
const MAX_BRANCHES = 16;

async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v as T;
  const v = await fn();
  if (v === null || v === undefined) return v;   // transient failures are not remembered
  if (cache.size > 1000) cache.clear();
  cache.set(key, { v, exp: Date.now() + ms });
  return v;
}

type Ov = {
  me: string;
  state?: Array<Record<string, any>>;
  learning?: { skills?: Array<Record<string, any>> };
  prefs?: Record<string, string>;
  contrib?: Array<{ task_id: number; human: string; n: number }>;
  crew_msgs?: Array<{ task_id: number; sender: string; last: number; n: number }>;
  tasks: Array<Record<string, any>>;
  who: Array<Record<string, any>>;
  activity?: Record<string, number>;
  nudge_marks?: Array<{ id: number; to_agent: string; status: string }>;
};

export async function buildTown(ov: Ov, repo: string, token?: string) {
  // A task without its own branch borrows its agent's current branch (reported by the session-start hook), as long
  // as that isn't the default branch or a detached HEAD.
  const agentBranch = new Map(ov.who.map((a) => [a.id, a.branch as string | null]));
  const tasks = ov.tasks.filter((t) => t.status !== "dropped").map((t): Record<string, any> => {
    if (t.branch || t.status === "done") return { ...t, branch_source: t.branch ? "task" : null };
    const holder = t.owner || (t.status === "open" ? t.last_owner : null);
    if (!holder) return { ...t, branch_source: null };
    const b = agentBranch.get(holder);
    return b && b !== "HEAD" ? { ...t, branch: b, branch_source: "agent" } : { ...t, branch_source: null };
  });
  type Cmp = { ahead: number; url: string; status: string; files: number; add: number; del: number } | { missing: true } | null;
  const commits: Record<string, Cmp> = {};
  let base: string | null = null;
  if (token) {
    base = await cached(`base|${repo}`, 3_600_000, async () => {
      try {
        const r = await gh(`/repos/${repo}`, token);
        return r.ok ? ((await r.json()) as { default_branch: string }).default_branch : null;
      } catch { return null; }
    });
    const branches = [...new Set(tasks.filter((t) => t.branch && t.status !== "open" && t.branch !== base).map((t) => String(t.branch)))].slice(0, MAX_BRANCHES);
    await Promise.all(branches.map(async (b) => {
      // A failed lookup degrades that one tower to "no commit data"; it never fails the whole town.
      commits[b] = base
        ? await cached(`cmp|${repo}|${base}|${b}`, 300_000, async () => {
            try {
              const seg = (x: string) => x.split("/").map(encodeURIComponent).join("/");
              const r = await gh(`/repos/${repo}/compare/${seg(base!)}...${seg(b)}?per_page=1`, token);
              if (r.status === 404) return { missing: true as const };
              if (!r.ok) return null;
              const j = (await r.json()) as { ahead_by: number; html_url: string; status: string; files?: Array<{ additions: number; deletions: number }> };
              const files = j.files ?? [];
              return { ahead: j.ahead_by, url: j.html_url, status: j.status, files: files.length,
                add: files.reduce((a, f) => a + f.additions, 0), del: files.reduce((a, f) => a + f.deletions, 0) };
            } catch { return null; }
          })
        : null;
    }));
  }
  const cmp = (t: Record<string, any>): Cmp => (t.branch ? commits[t.branch] ?? null : null);
  const mergeState = (t: Record<string, any>) => {
    const c = cmp(t);
    if (!c) return null;
    if ("missing" in c) return t.branch_source === "task" ? "gone" : null;
    return c.status === "behind" || c.status === "identical" ? "merged" : "open";
  };
  const contrib: Record<number, Array<{ human: string; n: number }>> = {};
  for (const r of ov.contrib ?? []) (contrib[r.task_id] ??= []).push({ human: r.human, n: r.n });

  // Bridges between towers that share work: explicit dependencies, a shared branch, one task mentioning the other,
  // or the same file linked from both.
  const links: Array<{ a: number; b: number; kind: "dep" | "shared" }> = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, kind: "dep" | "shared") => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(k)) return;
    seen.add(k); links.push({ a, b, kind });
  };
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) for (const d of t.deps ?? []) if (ids.has(d)) add(t.id, d, "dep");
  const sample = tasks.slice(0, 80);
  for (const t of sample) {
    const text = `${t.title} ${t.detail ?? ""} ${t.result ?? ""}`;
    for (const m of text.matchAll(/\bT(\d+)\b/g)) if (ids.has(Number(m[1]))) add(t.id, Number(m[1]), "shared");
  }
  for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) {
    const a = sample[i], b = sample[j];
    if (a.branch && a.branch === b.branch && a.branch_source === "task" && b.branch_source === "task") add(a.id, b.id, "shared");
    else if ((a.links ?? []).some((l: string) => (b.links ?? []).includes(l))) add(a.id, b.id, "shared");
  }

  // Only depths the hub hasn't already recorded need writing back.
  // Crew: every agent connected to a task, and how. Order: holder, author, agents whose status names it, posters.
  const ROLES = ["planner", "researcher", "coder", "reviewer", "backtester"];
  const roleOf = (id: string) => { const last = String(id).split("-").pop() ?? ""; return ROLES.includes(last) ? last : null; };
  const agentById = new Map(ov.who.map((a) => [a.id as string, a]));
  const crewOf = (t: Record<string, any>) => {
    const out: Array<{ id: string; human: string; role: string | null; active: boolean; doing: string | null; last_seen: number | null; via: string[] }> = [];
    const addc = (id: string | null | undefined, via: string) => {
      if (!id || id === "wcomms") return;
      const a = agentById.get(id);
      if (a && a.id === a.human) return;                 // a human posting from the dashboard is not crew
      let c = out.find((x) => x.id === id);
      if (!c) {
        c = { id, human: a?.human ?? String(id).split("@")[0], role: roleOf(id), active: !!a?.active, doing: a?.doing ?? null, last_seen: a?.heartbeat_at ?? null, via: [] };
        out.push(c);
      }
      if (!c.via.includes(via)) c.via.push(via);
    };
    addc(t.owner, "holds");
    addc(t.last_owner, "held");
    addc(t.submitted_by, "author");
    const tag = new RegExp(`\\bT${t.id}\\b`);
    for (const a of ov.who) if (a.doing && tag.test(String(a.doing))) addc(a.id, "status");
    for (const m of ov.crew_msgs ?? []) if (m.task_id === t.id) addc(m.sender, "posted");
    return out;
  };

  const remember: Record<number, number> = {};
  for (const t of tasks) { const c = cmp(t); if (c && "ahead" in c && c.ahead > (t.commits_seen ?? 0)) remember[t.id] = c.ahead; }

  return {
    repo, base, me: ov.me, github: !!token, remember,
    prefs: ov.prefs ?? {},
    links,
    state: (ov.state ?? []).map((s) => ({ key: s.key, value: String(s.value).slice(0, 2000), version: s.version, updated_by: s.updated_by, decided_by: s.decided_by, note: s.note, updated_at: s.updated_at })),
    skills: (ov.learning?.skills ?? []).map((s) => ({ name: s.name, description: s.description, status: s.status, use_count: s.use_count, last_used_at: s.last_used_at, roles: s.roles, version: s.version })),
    tasks: tasks.map((t) => { const c = cmp(t); const ahead = c && "ahead" in c ? c.ahead : null; return {
      id: t.id, title: t.title, status: t.status, role: t.role, owner: t.owner, owner_human: t.owner_human,
      submitted_by: t.submitted_by, last_owner: t.last_owner, created_by: t.created_by, branch: t.branch, branch_source: t.branch_source, head_sha: t.head_sha, result: t.result, deps: t.deps,
      updated_at: t.updated_at, activity: ov.activity?.[t.id] ?? 0,
      commits: ahead === null && !t.commits_seen ? null : Math.max(ahead ?? 0, t.commits_seen ?? 0),
      compare_url: c && "url" in c ? c.url : null,
      diff: c && "files" in c ? { files: c.files, add: c.add, del: c.del } : null,
      merge_state: mergeState(t),
      shipped: !!t.shipped,
      links: t.links ?? [],
      detail: t.detail ?? null,
      contributors: (contrib[t.id] ?? []).sort((x, y) => y.n - x.n),
      crew: crewOf(t),
    }; }),
    marks: ov.nudge_marks ?? [],
    who: ov.who.map((a) => ({ id: a.id, human: a.human, active: a.active, doing: a.doing, tasks: a.tasks, machine: a.machine, branch: a.branch })),
  };
}
