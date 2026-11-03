// Identity comes from GitHub: anyone with push access to a repo can use that repo's hub.
//  - Agents and the CLI send their own GitHub token (from `gh auth token` or GH_TOKEN) as a bearer token.
//  - Humans sign in to the dashboard with GitHub OAuth; that browser session is the only way to approve
//    learning proposals, so an agent holding a gh token still can't approve its own proposal.
import type { Env } from "./index";

export type Access = { login: string; admin: boolean; token?: string };

const GH = "https://api.github.com";
const CACHE_MS = 10 * 60_000;
const SESSION_DAYS = 7;
const cache = new Map<string, { login: string; push: boolean; exp: number }>();

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sha256(s: string) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export function gh(path: string, token: string) {
  return fetch(GH + path, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "wcomms" },
  });
}

/** GitHub login of the token's owner, and whether they can push to owner/repo. Cached briefly per token+repo. */
export async function repoAccess(token: string, repo: string): Promise<{ login: string; push: boolean } | null> {
  const key = (await sha256(token)) + "|" + repo;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit;
  const [u, r] = await Promise.all([gh("/user", token), gh(`/repos/${repo}`, token)]);
  if (!u.ok) return null;
  const login = String(((await u.json()) as { login: string }).login).toLowerCase();
  const perms = r.ok ? ((await r.json()) as { permissions?: { push?: boolean } }).permissions : undefined;
  const entry = { login, push: !!perms?.push, exp: Date.now() + CACHE_MS };
  if (cache.size > 500) for (const [k, v] of cache) if (v.exp < Date.now() || cache.size > 500) cache.delete(k);
  cache.set(key, entry);
  return entry;
}

// ---------- dashboard sessions (AES-GCM encrypted cookie holding the user's OAuth token) ----------

async function key(env: Env) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env: Env, data: object) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(JSON.stringify(data)));
  return b64url(iv) + "." + b64url(ct);
}

async function unseal<T>(env: Env, v: string): Promise<T | null> {
  try {
    const [iv, ct] = v.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await key(env), unb64url(ct));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

function cookie(req: Request, name: string) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

export async function sessionToken(req: Request, env: Env): Promise<string | null> {
  const v = cookie(req, "wc_session");
  const s = v ? await unseal<{ t: string; e: number }>(env, v) : null;
  return s && s.e > Date.now() ? s.t : null;
}

const isLocal = (url: URL) => ["localhost", "127.0.0.1"].includes(url.hostname);
const devMap = (raw: string | undefined) => JSON.parse(raw || "{}") as Record<string, string>;

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  // wrangler dev only: /auth/dev?token=<INSECURE_DEV_ADMIN_TOKENS key> signs the browser in without GitHub.
  if (url.pathname === "/auth/dev") {
    const t = url.searchParams.get("token") ?? "";
    if (!isLocal(url) || !devMap(env.INSECURE_DEV_ADMIN_TOKENS)[t]) return new Response("not found", { status: 404 });
    const session = await seal(env, { t, e: Date.now() + 86_400_000 });
    return new Response(null, { status: 302, headers: { location: safeNext(url.searchParams.get("next")), "set-cookie": setCookie("wc_session", session, 86_400) } });
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response("GitHub sign-in is not configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.", { status: 500 });
  }
  if (url.pathname === "/auth/login") {
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const next = safeNext(url.searchParams.get("next"));
    const to = new URL("https://github.com/login/oauth/authorize");
    to.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    to.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
    // `repo` lets the hub check your permission on private repos (the same scope `gh auth login` grants).
    to.searchParams.set("scope", "read:user repo");
    to.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: to.toString(), "set-cookie": setCookie("wc_state", `${state}|${next}`, 600) } });
  }
  if (url.pathname === "/auth/callback") {
    const [state, next] = (cookie(req, "wc_state") ?? "|").split("|");
    if (!state || state !== url.searchParams.get("state")) return new Response("Sign-in expired, try again.", { status: 400 });
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code") }),
    });
    const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!body.access_token) {
      // GitHub's error names are safe to show and tell the operator exactly what to fix (usually the client secret).
      const why = body.error === "incorrect_client_credentials"
        ? "GitHub rejected the client secret. Re-upload it with: npx wrangler secret put GITHUB_CLIENT_SECRET"
        : body.error === "bad_verification_code" ? "the sign-in code expired or was already used; try again"
        : body.error_description || body.error || "unknown error";
      return new Response(`GitHub sign-in failed: ${why}`, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const tok = body.access_token;
    const session = await seal(env, { t: tok, e: Date.now() + SESSION_DAYS * 86_400_000 });
    const headers = new Headers({ location: safeNext(next) });
    headers.append("set-cookie", setCookie("wc_session", session, SESSION_DAYS * 86_400));
    headers.append("set-cookie", setCookie("wc_state", "", 0));
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === "/auth/logout") {
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie("wc_session", "", 0) } });
  }
  return new Response("not found", { status: 404 });
}

/**
 * Who is calling, for a given repo. Bearer (agents/CLI) -> member, never admin. Dashboard session -> admin.
 * INSECURE_DEV_TOKENS / INSECURE_DEV_ADMIN_TOKENS ({"token":"login"}) work only on localhost, for wrangler dev tests.
 */
export async function authenticate(req: Request, env: Env, url: URL, repo: string): Promise<Access | Response> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (isLocal(url)) {
    const dev = devMap(env.INSECURE_DEV_TOKENS);
    const devAdmin = devMap(env.INSECURE_DEV_ADMIN_TOKENS);
    if (bearer && devAdmin[bearer]) return { login: devAdmin[bearer], admin: true };
    if (bearer && dev[bearer]) return { login: dev[bearer], admin: false };
    const devSession = bearer ? null : await sessionToken(req, env);
    if (devSession && devAdmin[devSession]) return { login: devAdmin[devSession], admin: true };
  }

  let token = bearer;
  let admin = false;
  if (!token) {
    token = (await sessionToken(req, env)) ?? "";
    admin = !!token;
    // A cookie-authenticated write must carry this header, which a cross-site form or image can't send.
    if (admin && req.method !== "GET" && req.headers.get("x-requested-with") !== "wcomms") {
      return jsonErr("missing x-requested-with header", 403);
    }
  }
  if (!token) return unauthorized("sign in with GitHub, or send your GitHub token (gh auth token) as a bearer token");
  const a = await repoAccess(token, repo);
  if (!a) return unauthorized("GitHub rejected that token; run `gh auth login`");
  if (!a.push) return jsonErr(`${a.login} does not have push access to ${repo}`, 403);
  return { login: a.login, admin, token };
}

const jsonErr = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const unauthorized = (msg: string) => jsonErr(`unauthorized: ${msg}`, 401);
