// Live-session relay: one Durable Object per (repo, session). The host daemon sends encrypted terminal frames; viewers
// receive them. The relay never sees plaintext (frames are encrypted end to end with the team key) and keeps only a
// short replay buffer so a viewer who joins late sees the recent screen. Phase A is watch-only: viewer input is dropped.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const REPLAY_BYTES = 96 * 1024;
const MAX_FRAME = 64 * 1024;

type Attach = { role: "host" | "viewer"; who: string };

export class Relay extends DurableObject<Env> {
  private replay: ArrayBuffer[] = [];
  private replaySize = 0;
  private cols = 0;
  private rows = 0;
  private loaded = false;

  /** The object can be put to sleep between messages; size and replay live in storage so a wake-up loses nothing. */
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const size = await this.ctx.storage.get<{ cols: number; rows: number }>("size");
    if (size) { this.cols = size.cols; this.rows = size.rows; }
    const replay = await this.ctx.storage.get<ArrayBuffer[]>("replay");
    if (replay) { this.replay = replay; this.replaySize = replay.reduce((n, b) => n + b.byteLength, 0); }
  }
  private persist() {
    void this.ctx.storage.put("size", { cols: this.cols, rows: this.rows });
    void this.ctx.storage.put("replay", this.replay);
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
      void this.ctx.storage.deleteAll();
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
