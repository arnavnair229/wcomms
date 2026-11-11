#!/usr/bin/env python3
"""wcomms share: run a command in your terminal exactly as usual, and let teammates watch it live from the town.

  wcomms-share.py <command...>        e.g. wcomms-share.py claude   |  wcomms-share.py codex  |  wcomms-share.py bash

How it works, in one breath: the command runs in a real pseudo-terminal on this machine; everything it prints is
mirrored to your screen and, batched every 50 ms, encrypted with the team key and sent over a WebSocket to the
relay on your Worker, which forwards ciphertext to viewers. Watch-only: nothing a viewer does can reach this shell.

End-to-end encryption, standard library only: key = PBKDF2-HMAC-SHA256(team passphrase, "wcomms:" + repo);
keystream = HMAC-SHA256(k_enc, nonce || counter) in counter mode; tag = HMAC-SHA256(k_mac, nonce || ciphertext).
The Worker never has the passphrase. Without WCOMMS_TEAM_KEY nothing is shared.

Env (exported by wcomms.sh): WCOMMS_API, WCOMMS_TOKEN, WCOMMS_TEAM_KEY, WCOMMS_REPO, WCOMMS_MACHINE, WCOMMS_STATE_DIR.
"""
import base64
import fcntl
import hashlib
import hmac
import json
import os
import pty
import secrets
import select
import signal
import socket
import ssl
import struct
import sys
import termios
import threading
import time
import tty
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("WCOMMS_API", "").rstrip("/")
TOKEN = os.environ.get("WCOMMS_TOKEN", "")
REPO = os.environ.get("WCOMMS_REPO", "")
PASS = os.environ.get("WCOMMS_TEAM_KEY", "")
MACHINE = os.environ.get("WCOMMS_MACHINE") or socket.gethostname().split(".")[0]
SESSION_ENV = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
FLUSH_MS = 50
MAX_CHUNK = 48 * 1024


# ---------- crypto ----------

class Box:
    def __init__(self, passphrase, repo):
        master = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), ("wcomms:" + repo).encode(), 200_000, 32)
        self.k_enc = hmac.new(master, b"enc", hashlib.sha256).digest()
        self.k_mac = hmac.new(master, b"mac", hashlib.sha256).digest()

    def seal(self, data):
        nonce = secrets.token_bytes(12)
        out = bytearray()
        for i in range(0, len(data), 32):
            ks = hmac.new(self.k_enc, nonce + struct.pack(">I", i // 32), hashlib.sha256).digest()
            block = data[i:i + 32]
            out += bytes(a ^ b for a, b in zip(block, ks))
        tag = hmac.new(self.k_mac, nonce + bytes(out), hashlib.sha256).digest()
        return b"\x01" + nonce + bytes(out) + tag


# ---------- minimal WebSocket client (RFC 6455), TLS, client-masked frames ----------

class WS:
    def __init__(self, url, token):
        u = urllib.parse.urlparse(url)
        self.host, self.port, self.path = u.hostname, u.port or (443 if u.scheme == "wss" else 80), u.path + ("?" + u.query if u.query else "")
        raw = socket.create_connection((self.host, self.port), timeout=15)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host) if u.scheme == "wss" else raw
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        req = (f"GET {self.path} HTTP/1.1\r\nHost: {self.host}:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer {token}\r\n\r\n")
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("relay closed during handshake")
            resp += chunk
        head, _, rest = resp.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError("relay refused: " + head.split(b"\r\n")[0].decode(errors="replace"))
        self.buf = rest
        self.lock = threading.Lock()
        self.sock.settimeout(None)

    def _send(self, opcode, payload):
        mask = secrets.token_bytes(4)
        n = len(payload)
        hdr = bytes([0x80 | opcode])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(hdr + mask + masked)

    def send_bytes(self, b): self._send(0x2, b)
    def send_text(self, s): self._send(0x1, s.encode())

    def close(self):
        try: self._send(0x8, b"")
        except Exception: pass
        try: self.sock.close()
        except Exception: pass

    def _read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("relay closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Returns (opcode, payload); answers pings itself."""
        while True:
            b1, b2 = self._read_exact(2)
            op, n = b1 & 0x0F, b2 & 0x7F
            if n == 126: n = struct.unpack(">H", self._read_exact(2))[0]
            elif n == 127: n = struct.unpack(">Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if b2 & 0x80 else None
            payload = self._read_exact(n)
            if mask: payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if op == 0x9: self._send(0xA, payload); continue
            if op == 0x8: raise ConnectionError("relay closed")
            return op, payload


# ---------- hub registration ----------

def api(path, body):
    req = urllib.request.Request(API + path, method="POST", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode() or "null")


# ---------- the shared terminal ----------

def winsize():
    try:
        return struct.unpack("HHHH", fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8))
    except Exception:
        return (40, 140, 0, 0)


def main():
    argv = sys.argv[1:] or [os.environ.get("SHELL", "/bin/bash")]
    if not sys.stdin.isatty():
        os.execvp(argv[0], argv)
    if not (API and TOKEN and REPO):
        print("wcomms share: not configured (needs .claude/wcomms.json and a GitHub login)", file=sys.stderr)
        os.execvp(argv[0], argv)
    if not PASS:
        print("wcomms share: no team key. Set one with '.claude/wcomms.sh team-key set' (same passphrase for everyone), then try again.", file=sys.stderr)
        os.execvp(argv[0], argv)

    box = Box(PASS, REPO)
    sid = secrets.token_hex(10)
    agent = f"{os.environ.get('WCOMMS_LOGIN', '').lower() or 'me'}@{MACHINE.lower()}-{(SESSION_ENV or sid)[:6]}"
    try:
        reg = api("/api/live/start", {"id": sid, "cmd": os.path.basename(argv[0]), "cwd": os.getcwd(),
                                      "session": SESSION_ENV or sid, "machine": MACHINE})
        agent = reg.get("agent", agent)
    except urllib.error.HTTPError as e:
        try: why = json.loads(e.read().decode()).get("error", "")
        except Exception: why = ""
        print(f"wcomms share: the hub refused ({e.code}{': ' + why if why else ''}); running unshared", file=sys.stderr)
        os.execvp(argv[0], argv)
    except Exception as e:
        print(f"wcomms share: could not reach the hub ({e}); running unshared", file=sys.stderr)
        os.execvp(argv[0], argv)

    ws_url = API.replace("https://", "wss://").replace("http://", "ws://") + f"/live/{sid}?role=host"
    try:
        ws = WS(ws_url, TOKEN)
    except Exception as e:
        print(f"wcomms share: relay unavailable ({e}); running unshared", file=sys.stderr)
        os.execvp(argv[0], argv)

    rows, cols, _, _ = winsize()
    ws.send_text(json.dumps({"t": "size", "cols": cols, "rows": rows}))
    print(f"\033[2m[wcomms] sharing this {os.path.basename(argv[0])} session as {agent} (watch-only; team key required to view)\033[0m", flush=True)

    pid, master = pty.fork()
    if pid == 0:
        os.environ["WCOMMS_SHARING"] = "1"
        os.execvp(argv[0], argv)

    def apply_size(*_):
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", *winsize()))
            r, c, _, _ = winsize()
            ws.send_text(json.dumps({"t": "size", "cols": c, "rows": r}))
        except Exception:
            pass
    apply_size()
    signal.signal(signal.SIGWINCH, apply_size)

    pending = bytearray()
    plock = threading.Lock()
    alive = True

    def sender():
        last_beat = time.time()
        while alive:
            time.sleep(FLUSH_MS / 1000)
            with plock:
                chunk, pending[:] = bytes(pending), b""
            try:
                for i in range(0, len(chunk), MAX_CHUNK):
                    ws.send_bytes(box.seal(chunk[i:i + MAX_CHUNK]))
                if time.time() - last_beat > 30:
                    api("/api/live/beat", {"id": sid}); last_beat = time.time()
            except Exception:
                pass

    def receiver():
        while alive:
            try:
                ws.recv()          # pings are answered inside; viewer counts are informational
            except Exception:
                break

    threading.Thread(target=sender, daemon=True).start()
    threading.Thread(target=receiver, daemon=True).start()

    old = termios.tcgetattr(sys.stdin.fileno())
    tty.setraw(sys.stdin.fileno())
    try:
        while True:
            r, _, _ = select.select([sys.stdin.fileno(), master], [], [])
            if master in r:
                try: data = os.read(master, 65536)
                except OSError: break
                if not data: break
                os.write(sys.stdout.fileno(), data)
                with plock: pending += data
            if sys.stdin.fileno() in r:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data: break
                os.write(master, data)
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)
        alive = False
        try: api("/api/live/end", {"id": sid})
        except Exception: pass
        ws.close()
        try: _, status = os.waitpid(pid, 0)
        except ChildProcessError: status = 0
        print("\033[2m[wcomms] sharing ended\033[0m")
        sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
