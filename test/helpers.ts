import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSignalingServer, host, join, Session, type Link, type SessionOptions, type SignalingOptions } from "../src/index.js";

export const ICE = { bindAddress: "127.0.0.1" } as const;

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

export async function startSignaling(opts?: SignalingOptions): Promise<{ url: string; stop: () => void }> {
  const server = createSignalingServer(opts);
  const url = await listen(server);
  return { url, stop: () => { server.closeAllConnections(); server.close(); } };
}

/** A transparent reverse proxy that records every byte and may rewrite request bodies. */
export async function startProxy(target: string, tamper?: (body: string) => string): Promise<{ url: string; seen: () => string; stop: () => void }> {
  const log: string[] = [];
  const read = async (m: IncomingMessage) => { const c: Buffer[] = []; for await (const x of m) c.push(x as Buffer); return Buffer.concat(c).toString("utf8"); };
  const server = createServer(async (req, res) => {
    let body = await read(req);
    log.push(`${req.method} ${req.url}\n${body}`);
    if (tamper && req.method === "POST" && req.url?.endsWith("/blobs")) body = tamper(body);
    const up = request(target + (req.url ?? ""), { method: req.method, headers: { "content-type": "application/json" } }, async (r) => {
      const out = await read(r);
      log.push(out);
      res.writeHead(r.statusCode ?? 500, { "content-type": "application/json" });
      res.end(out);
    });
    up.on("error", () => res.destroy());
    res.on("close", () => up.destroy());
    up.end(body);
  });
  const url = await listen(server);
  return { url, seen: () => log.join("\n"), stop: () => { server.closeAllConnections(); server.close(); } };
}

export interface Pair { a: Session; b: Session; links: [Link, Link]; code: string; close: () => void }

/** Pair two sessions over real loopback WebRTC through `signalingUrl`. */
export async function pairSessions(signalingUrl: string, optsA: SessionOptions = {}, optsB: SessionOptions = {}): Promise<Pair> {
  const h = await host({ signalingUrl, ...ICE });
  const [guestLink, hostLink] = await Promise.all([join(h.code, { signalingUrl, ...ICE }), h.connected]);
  const a = new Session(hostLink, { name: "alpha", ...optsA });
  const b = new Session(guestLink, { name: "beta", ...optsB });
  return { a, b, links: [hostLink, guestLink], code: h.code, close: () => { a.close(); b.close(); } };
}

export function once<T extends unknown[]>(emitter: { once(e: string, cb: (...a: T) => void): unknown }, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    emitter.once(event, (...args: T) => { clearTimeout(t); resolve(args); });
  });
}
