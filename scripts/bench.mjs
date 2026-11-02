// Loopback benchmark on one machine. Measures this library only: no real network, no relay.
// Throughput is validated end to end: the receiver hashes every byte and acks, and time stops at the ack.
import { createHash, randomBytes } from "node:crypto";
import { createSignalingServer, host, join } from "../dist/index.js";

const server = createSignalingServer({ createsPerMinute: 10_000 });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ice = { signalingUrl: `http://127.0.0.1:${server.address().port}`, bindAddress: "127.0.0.1" };
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

const pairTimes = [];
let last;
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  const h = await host(ice);
  const [g, a] = await Promise.all([join(h.code, ice), h.connected]);
  pairTimes.push(performance.now() - t);
  if (last) { last[0].close(); last[1].close(); }
  last = [a, g];
}
const [a, g] = last;

// round trip of a 64-byte message, echoed by the peer
g.on("message", (m) => g.send(m));
const rtts = [];
for (let i = 0; i < 200; i++) {
  const t = performance.now();
  await new Promise((resolve) => { a.once("message", resolve); a.send(Buffer.alloc(64)); });
  rtts.push(performance.now() - t);
}
g.removeAllListeners("message");

// validated bulk transfer: random payload, sha256 on both sides, ack from the receiver
const MESSAGE = 256 * 1024, COUNT = 128;                       // 32 MiB total
const payload = Array.from({ length: COUNT }, () => randomBytes(MESSAGE));
const sentHash = createHash("sha256");
for (const m of payload) sentHash.update(m);
const recvHash = createHash("sha256");
let received = 0;
g.on("message", (m) => {
  if (m.length === 64 && received === COUNT * MESSAGE) return;
  recvHash.update(m); received += m.length;
  if (received === COUNT * MESSAGE) g.send(Buffer.from(recvHash.digest("hex")));
});
let peakBuffered = 0;
const ack = new Promise((resolve) => a.once("message", (m) => resolve(m.toString())));
const t = performance.now();
for (const m of payload) { a.send(m); peakBuffered = Math.max(peakBuffered, a.bufferedBytes); await a.drain(1024 * 1024); }
const remoteHash = await ack;
const seconds = (performance.now() - t) / 1000;
const verified = remoteHash === sentHash.digest("hex");
if (!verified) { console.error("hash mismatch: transfer corrupted"); process.exit(1); }

console.log(JSON.stringify({
  node: process.version, platform: `${process.platform}-${process.arch}`, transport: "loopback only, no STUN/TURN, no real network",
  pairMs: { runs: pairTimes.length, p50: +pct(pairTimes, 0.5).toFixed(1), max: +Math.max(...pairTimes).toFixed(1) },
  rttMs: { messages: rtts.length, payloadBytes: 64, p50: +pct(rtts, 0.5).toFixed(2), p95: +pct(rtts, 0.95).toFixed(2) },
  bulk: { payloadBytes: COUNT * MESSAGE, messageBytes: MESSAGE, seconds: +seconds.toFixed(2), mbitPerSec: +((COUNT * MESSAGE * 8) / 1e6 / seconds).toFixed(0), peakSenderBufferBytes: peakBuffered, sendBackpressureLimitBytes: 1048576, receiverHashVerified: verified },
}, null, 2));
a.close(); g.close(); server.close(); process.exit(0);
