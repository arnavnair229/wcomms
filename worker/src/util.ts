export const KINDS = ["note", "question", "result", "decision", "claim", "handoff", "system"];
export const POSTABLE_KINDS = KINDS.filter((k) => k !== "system");
export const TASK_STATUSES = ["open", "claimed", "running", "review", "done", "dropped"];
export const ROLES = ["planner", "researcher", "coder", "reviewer", "backtester"];

export class HubError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export function parseJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}


export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function trunc(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const truthy = (x: unknown) => x === true || x === 1 || x === "1" || x === "true";

const STOPWORDS = new Set(
  "the and for with from into onto that this then than are was were has have had not but via per use using add fix new run test study check try make update about over under more less".split(" "),
);

/** Normalised keyword set used to spot duplicate tasks. */
export function keywords(s: string): Set<string> {
  const out = new Set<string>();
  for (let w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}
