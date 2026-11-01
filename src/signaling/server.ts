// Minimal self-hostable signaling server. Dependency-free (node:http only).
// It relays opaque blobs between the two members of a room and nothing else:
// it never parses, logs or stores session content, and it cannot decrypt the blobs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Tunables for {@link createSignalingServer}. All have safe defaults. */
export interface SignalingOptions {
  /** How long a room lives without being deleted, in ms. Default 5 minutes. */
  roomTtlMs?: number;
  /** Max rooms held at once. Default 2000. */
  maxRooms?: number;
  /** Max bytes per posted blob. Default 32 KiB. */
  maxBlobBytes?: number;
  /** Max blobs per room. Default 8. */
  maxBlobsPerRoom?: number;
  /** Per-IP budget of room creations per minute. Default 10. */
  createsPerMinute?: number;
  /** Per-IP budget of lookups of unknown rooms per minute (blocks code guessing). Default 20. */
  missesPerMinute?: number;
  /** Long-poll duration in ms. Default 20000. */
  pollMs?: number;
}

interface Blob { n: number; from: string; data: string }
interface Room { createdAt: number; blobs: Blob[]; waiters: Set<() => void> }

const ROOM_RE = /^[0-9a-f]{32}$/;

/** Create (but do not start) the signaling HTTP server. Call `.listen(port)` on the result. */
export function createSignalingServer(opts: SignalingOptions = {}): Server {
  const ttl = opts.roomTtlMs ?? 300_000;
  const maxRooms = opts.maxRooms ?? 2000;
  const maxBlob = opts.maxBlobBytes ?? 32 * 1024;
  const maxBlobs = opts.maxBlobsPerRoom ?? 8;
  const createLimit = opts.createsPerMinute ?? 10;
  const missLimit = opts.missesPerMinute ?? 20;
  const pollMs = opts.pollMs ?? 20_000;

  const rooms = new Map<string, Room>();
  const buckets = new Map<string, { windowStart: number; creates: number; misses: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) if (now - room.createdAt > ttl) drop(id);
    for (const [ip, b] of buckets) if (now - b.windowStart > 60_000) buckets.delete(ip);
  }, 5_000);
  sweep.unref();

  function drop(id: string): void {
    const room = rooms.get(id);
    rooms.delete(id);
    room?.waiters.forEach((wake) => wake());
  }

  /** Count one event against the caller's per-minute budget; returns false once it is spent. */
  function allow(ip: string, kind: "creates" | "misses", limit: number): boolean {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.windowStart > 60_000) buckets.set(ip, (b = { windowStart: now, creates: 0, misses: 0 }));
    return ++b[kind] <= limit;
  }

  function send(res: ServerResponse, status: number, body: unknown = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBlob + 256) throw new Error("too large");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? "unknown";
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (parts[0] !== "v1" || parts[1] !== "rooms") return send(res, 404);
    const id = parts[2];

    if (req.method === "POST" && parts.length === 3 && id) {
      if (!ROOM_RE.test(id)) return send(res, 400, { error: "bad room id" });
      if (!allow(ip, "creates", createLimit)) return send(res, 429, { error: "slow down" });
      if (rooms.has(id)) return send(res, 409, { error: "room exists" });
      if (rooms.size >= maxRooms) return send(res, 503, { error: "server full" });
      rooms.set(id, { createdAt: Date.now(), blobs: [], waiters: new Set() });
      return send(res, 201);
    }

    const room = id ? rooms.get(id) : undefined;
    if (!id || !ROOM_RE.test(id) || !room) {
      return allow(ip, "misses", missLimit) ? send(res, 404, { error: "no such room" }) : send(res, 429, { error: "slow down" });
    }

    if (req.method === "DELETE" && parts.length === 3) {
      drop(id);
      return send(res, 200);
    }

    if (req.method === "POST" && parts[3] === "blobs") {
      let body: { from?: unknown; data?: unknown };
      try { body = (await readJson(req)) as typeof body; } catch { return send(res, 400, { error: "bad body" }); }
      if ((body.from !== "host" && body.from !== "guest") || typeof body.data !== "string" || body.data.length > maxBlob) {
        return send(res, 400, { error: "bad blob" });
      }
      if (room.blobs.length >= maxBlobs) return send(res, 429, { error: "room full" });
      room.blobs.push({ n: room.blobs.length + 1, from: body.from, data: body.data });
      room.waiters.forEach((wake) => wake());
      return send(res, 201, { n: room.blobs.length });
    }

    if (req.method === "GET" && parts[3] === "blobs") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const wantFrom = url.searchParams.get("from");
      const pending = () => room.blobs.filter((b) => b.n > after && (!wantFrom || b.from === wantFrom));
      if (pending().length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, pollMs);
          function done(): void { clearTimeout(timer); room!.waiters.delete(done); resolve(); }
          room.waiters.add(done);
          res.on("close", done);
        });
      }
      return send(res, 200, { blobs: rooms.has(id) ? pending() : [], closed: !rooms.has(id) });
    }
    return send(res, 404);
  }

  const server = createServer((req, res) => { handle(req, res).catch(() => send(res, 500)); });
  server.on("close", () => clearInterval(sweep));
  server.headersTimeout = 10_000;
  return server;
}
