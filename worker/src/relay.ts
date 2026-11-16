// Live-session relay: one Durable Object per (repo, session). The host daemon sends encrypted terminal frames; viewers
// receive them. The relay never sees plaintext (frames are encrypted end to end with the team key) and keeps only a
// short replay buffer so a viewer who joins late sees the recent screen. Phase A is watch-only: viewer input is dropped.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const REPLAY_BYTES = 96 * 1024;
const MAX_FRAME = 64 * 1024;
const PERSIST_MS = 5000;

type Attach = { role: "host" | "viewer"; who: string };

export class Relay extends DurableObject<Env> {
  private sql: SqlStorage;
  private replay: ArrayBuffer[] = [];
  private replaySize = 0;
  private cols = 0;
  private rows = 0;
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS replay (id INTEGER PRIMARY KEY, cols INTEGER NOT NULL, rows INTEGER NOT NULL, data BLOB NOT NULL)");
  }

  /** The object can be put to sleep between messages; size and replay live in one SQL row so a wake-up loses nothing.
   *  Frames are stored back to back, each behind a 4-byte length. */
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const r = this.sql.exec<{ cols: number; rows: number; data: ArrayBuffer }>("SELECT cols, rows, data FROM replay WHERE id = 1").toArray()[0];
    if (!r) return;
    this.cols = r.cols; this.rows = r.rows;
    const v = new DataView(r.data);
    for (let o = 0; o + 4 <= r.data.byteLength;) {
      const n = v.getUint32(o); o += 4;
      this.replay.push(r.data.slice(o, o + n)); o += n;
    }
    this.replaySize = this.replay.reduce((n, b) => n + b.byteLength, 0);
  }
  /** Rows written are metered (100k a day on the free tier) and a busy terminal sends twenty frames a second, so the
   *  replay is written as one row at most every few seconds while frames flow. An eviction in between loses a few
   *  seconds of replay, nothing more. The timer is short enough not to matter for hibernation. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const buf = new Uint8Array(this.replaySize + 4 * this.replay.length);
      const v = new DataView(buf.buffer);
      let o = 0;
      for (const f of this.replay) { v.setUint32(o, f.byteLength); o += 4; buf.set(new Uint8Array(f), o); o += f.byteLength; }
      this.sql.exec(
        "INSERT INTO replay (id, cols, rows, data) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cols = excluded.cols, rows = excluded.rows, data = excluded.data",
        this.cols, this.rows, buf.buffer,
      );
    }, PERSIST_MS);
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    if (url.pathname.endsWith("/stats")) {
      const ws = this.ctx.getWebSockets();
      return Response.json({
        host: ws.some((s) => (s.deserializeAttachment() as Attach | null)?.role === "host"),
        viewers: ws.filter((s) => (s.deserializeAttachment() as Attach | null)?.role === "viewer").map((s) => (s.deserializeAttachment() as Attach).who),
      });
    }
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const role = url.searchParams.get("role") === "host" ? "host" : "viewer";
    const who = req.headers.get("x-wcomms-human") ?? "?";
    if (role === "host") {
      // One host per session: a reconnecting daemon replaces the old socket.
      for (const s of this.ctx.getWebSockets()) if ((s.deserializeAttachment() as Attach | null)?.role === "host") s.close(4000, "replaced");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, who } satisfies Attach);
    if (role === "viewer") {
      // Replay first, then the live stream. A size frame tells the viewer's terminal how big the host's is.
      if (this.cols) server.send(JSON.stringify({ t: "size", cols: this.cols, rows: this.rows }));
      for (const f of this.replay) server.send(f);
      server.send(JSON.stringify({ t: "live" }));
      this.broadcast(JSON.stringify({ t: "viewers", n: this.viewerCount() }), "host");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
    await this.load();
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;
    if (a.role === "viewer") return;                       // watch-only in this phase
    if (typeof msg === "string") {
      try {
        const m = JSON.parse(msg);
        if (m.t === "size") { this.cols = Number(m.cols) || 0; this.rows = Number(m.rows) || 0; this.persist(); }
        if (m.t === "clear") { this.replay = []; this.replaySize = 0; this.persist(); }
      } catch { /* ignore */ }
      this.broadcast(msg, "viewer");
      return;
    }
    if (msg.byteLength > MAX_FRAME) return;
    this.replay.push(msg);
    this.replaySize += msg.byteLength;
    while (this.replaySize > REPLAY_BYTES && this.replay.length > 1) this.replaySize -= this.replay.shift()!.byteLength;
    this.persist();
    this.broadcast(msg, "viewer");
  }

  async webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attach | null;
    if (a?.role === "host") {
      this.broadcast(JSON.stringify({ t: "host-gone" }), "viewer");
      // The session is over: drop the replay so nothing lingers in storage.
      this.replay = []; this.replaySize = 0; this.cols = 0; this.rows = 0;
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
      this.sql.exec("DELETE FROM replay");
    }
    else this.broadcast(JSON.stringify({ t: "viewers", n: this.viewerCount() - 1 }), "host");
  }

  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws); }

  private viewerCount() {
    return this.ctx.getWebSockets().filter((s) => (s.deserializeAttachment() as Attach | null)?.role === "viewer").length;
  }

  private broadcast(msg: ArrayBuffer | string, to: "host" | "viewer") {
    for (const s of this.ctx.getWebSockets()) {
      if ((s.deserializeAttachment() as Attach | null)?.role !== to) continue;
      try { s.send(msg); } catch { /* closed */ }
    }
  }
}
