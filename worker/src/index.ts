import { authenticate, handleAuth } from "./auth";
import { Hub } from "./hub";
import { Relay } from "./relay";
import { buildTown } from "./town";
import DASHBOARD_HTML from "./dashboard.html";
import { json } from "./util";

export { Hub, Relay };

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  RELAY: DurableObjectNamespace<Relay>;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  NTFY_TOPICS?: string;
  CLAIM_TTL_MIN?: string;
  CLAIM_HARD_TTL_HOURS?: string;
  ALLOWED_OWNERS?: string;
  INSECURE_DEV_TOKENS?: string;
  INSECURE_DEV_ADMIN_TOKENS?: string;
}

// Browser hardening for the two HTML pages. Scripts and fonts come only from the named CDNs; nothing may frame us.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });

const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0809"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="wcomms">
<title>wcomms</title><style>
:root{--bg:#0a0809;--ink:#f3eef0;--muted:#b5abaf;--line:rgba(255,240,244,.13);--brand:#7b1730;--accent:#d4607f}
@media (prefers-color-scheme:light){:root{--bg:#f8f5f4;--ink:#1c1416;--muted:#5c5054;--line:rgba(40,0,12,.15);--accent:#8c1c3a}}
body{margin:0;background:radial-gradient(700px 300px at 20% -80px,rgba(150,25,62,.3),transparent 70%),var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:460px;margin:15vh auto;padding:0 16px}
.mark{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#7b1730,#3a0a17);display:grid;place-items:center;color:#f4eef0;font-weight:700;font-size:18px;margin-bottom:14px}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-.02em}
input,button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit}
button{background:linear-gradient(180deg,#f6f3f4,#c8c1c4);color:#140e10;border-color:transparent;cursor:pointer;font-weight:500}
@media (prefers-color-scheme:light){button{background:linear-gradient(180deg,#93203f,#6c1530);color:#fff}}
form{display:flex;gap:8px}input{flex:1}p{color:var(--muted)}a{color:var(--accent)}
@media (pointer:coarse){input{font-size:16px}button,input{min-height:44px}}
</style></head><body><main><div class="mark">w</div><h1>wcomms</h1>
<p>Coordination for every Claude Code agent on a GitHub repo. Anyone with push access to the repo can open its hub.</p>
<form onsubmit="location.href='/r/'+this.r.value.trim().replace(/^https:\\/\\/github.com\\//,'').replace(/\\.git$/,'')+'/';return false">
<input name="r" placeholder="owner/repo" required><button>Open</button></form>
<p><a href="/auth/login?next=/">Sign in with GitHub</a> · <a href="/auth/logout">Sign out</a></p></main></body></html>`;

/** Operator check: are the GitHub OAuth credentials the ones GitHub expects? Uses the app-token endpoint, which
 *  answers 404 (no such token) when the credentials are right and 401 when they are wrong. Reveals nothing else. */
async function deepHealth(env: Env) {
  const out: Record<string, string> = { worker: "ok", session_secret: env.SESSION_SECRET ? "set" : "missing" };
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return { ...out, github_oauth: "not configured" };
  const r = await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`), accept: "application/vnd.github+json", "user-agent": "wcomms", "content-type": "application/json" },
    body: JSON.stringify({ access_token: "wcomms-credential-check" }),
  });
  out.github_oauth = r.status === 404 ? "ok" : r.status === 401 ? "bad credentials: client id or secret does not match the OAuth App" : `unexpected ${r.status}`;
  out.github_client_id = env.GITHUB_CLIENT_ID;
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") return html(LANDING);
    if (url.pathname === "/healthz") return url.searchParams.has("deep") ? json(await deepHealth(env)) : new Response("ok");
    if (url.pathname.startsWith("/auth/")) return handleAuth(req, env, url);

    // Every project lives under /r/<owner>/<repo>/ and gets its own Durable Object.
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/);
    if (!m) return json({ error: "not found" }, 404);
    const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`.toLowerCase();
    const rest = m[3] || "/";
    // A hosted Worker serves only the GitHub owners it was set up for. Without this, anyone with the code could point
    // their own repos at someone else's deployment. Unset = open (fine for a private deployment you fully control).
    const allowed = (env.ALLOWED_OWNERS ?? "").split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(m[1].toLowerCase()) && !allowed.includes(repo)) {
      return json({ error: `this wcomms deployment does not serve ${repo}. Ask its operator to add the owner to ALLOWED_OWNERS, or host your own (see README).` }, 403);
    }
    if (rest === "/" && req.method === "GET") return html(DASHBOARD_HTML);
    if (!rest.startsWith("/api/") && rest !== "/mcp" && !rest.startsWith("/live/")) return json({ error: "not found" }, 404);

    const who = await authenticate(req, env, url, repo);
    if (who instanceof Response) return who;

    // Live terminal relay: /live/<session id> (websocket, ?role=host|viewer) and /live/<id>/stats.
    const live = rest.match(/^\/live\/([A-Za-z0-9_-]{6,64})(\/stats)?$/);
    if (live) {
      const relay = env.RELAY.get(env.RELAY.idFromName(`${repo}/${live[1]}`));
      const h = new Headers(req.headers);
      h.set("x-wcomms-human", who.login);
      return relay.fetch(new Request(req.url, { method: req.method, headers: h }));
    }

    const headers = new Headers(req.headers);
    headers.set("x-wcomms-human", who.login);
    headers.set("x-wcomms-admin", who.admin ? "1" : "0");
    headers.set("x-wcomms-repo", repo);
    headers.set("x-wcomms-internal", "0");
    const inner = new URL(req.url);
    inner.pathname = rest;
    const hub = env.HUB.get(env.HUB.idFromName(repo));
    if (rest === "/api/town" && req.method === "GET") {
      inner.pathname = "/api/overview";
      const ov = await (await hub.fetch(new Request(inner.toString(), { headers }))).json();
      const town = await buildTown(ov as Parameters<typeof buildTown>[0], repo, who.token);
      if (Object.keys(town.remember).length) {
        inner.pathname = "/api/town/remember";
        const internal = new Headers(headers);
        internal.set("x-wcomms-internal", "1");
        await hub.fetch(new Request(inner.toString(), { method: "POST", headers: internal, body: JSON.stringify({ commits: town.remember }) }));
      }
      const out = json(town);
      out.headers.set("cache-control", "no-store");
      return out;
    }
    const res = await hub.fetch(new Request(inner.toString(), { method: req.method, headers, body: req.body }));
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "no-store");
    out.headers.set("x-content-type-options", "nosniff");
    return out;
  },
} satisfies ExportedHandler<Env>;
