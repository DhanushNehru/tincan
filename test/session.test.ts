import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createPatch, LIMITS, MAX_MESSAGE_BYTES, type PatchOutcome, type Task } from "../src/index.js";
import { once, pairSessions, startSignaling } from "./helpers.js";

let sig: Awaited<ReturnType<typeof startSignaling>>;
before(async () => { sig = await startSignaling({ createsPerMinute: 1000 }); });
after(() => sig.stop());

test("context syncs both ways, last writer wins, and bounds hold", async () => {
  const p = await pairSessions(sig.url);
  try {
    const seen = once(p.b, "context");
    p.a.setContext("goal", { text: "ship it" });
    await seen;
    assert.deepEqual(p.b.getContext("goal"), { text: "ship it" });
    const back = once(p.a, "context");
    p.b.setContext("goal", "revised");
    await back;
    assert.equal(p.a.getContext("goal"), "revised");
    assert.deepEqual(p.a.contextSnapshot(), { goal: "revised" });
    assert.throws(() => p.a.setContext("x", "y".repeat(70 * 1024)), /out of bounds/);
  } finally { p.close(); }
});

test("task handoff is delivered, answered, and never executed", async () => {
  const p = await pairSessions(sig.url);
  try {
    const got = once<[Task]>(p.b, "task");
    const id = p.a.handoff({ title: "Fix flaky test", instructions: "rm -rf / (this text must stay inert)" });
    const [task] = await got;
    assert.equal(task.id, id);
    assert.equal(task.title, "Fix flaky test");
    const reply = once(p.a, "taskReply");
    p.b.replyToTask({ id, status: "declined", note: "no thanks" });
    assert.deepEqual((await reply)[0], { id, status: "declined", note: "no thanks" });
  } finally { p.close(); }
});

test("registered custom messages deliver data without executing it", async () => {
  const p = await pairSessions(sig.url);
  try {
    const payload = { text: "process.exit()", nested: [1, true] };
    const received = new Promise<unknown>((resolve) => p.b.register("x-example/review", resolve));
    p.a.sendCustom("x-example/review", payload);
    assert.deepEqual(await received, payload);
    assert.throws(() => p.b.register("review", () => undefined), /must be namespaced/);
    assert.throws(() => p.b.register("x-example/review", () => undefined), /already registered/);
  } finally { p.close(); }
});

test("unknown custom types are ignored and leave the session usable", async () => {
  const p = await pairSessions(sig.url);
  try {
    (p.a as unknown as { send(f: object): void }).send({ t: "custom", type: "x-other/future", payload: { safe: true } });
    const seen = once(p.b, "context");
    p.a.setContext("still-open", true);
    await seen;
    assert.equal(p.b.getContext("still-open"), true);
  } finally { p.close(); }
});

test("custom messages enforce payload size and per-minute send limits", async () => {
  const p = await pairSessions(sig.url);
  try {
    assert.throws(() => p.a.sendCustom("x-example/data", "x".repeat(LIMITS.customMessageBytes)), /too large/);
    assert.throws(() => p.a.sendCustom("x-example/data", undefined), /JSON-serializable/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => p.a.sendCustom("x-example/data", circular), /JSON-serializable/);
    for (let i = 0; i < LIMITS.customMessagesPerMinute; i++) p.a.sendCustom("x-example/data", i);
    assert.throws(() => p.a.sendCustom("x-example/data", "over limit"), /rate limit exceeded/);
  } finally { p.close(); }
});

test("oversize custom payloads close the session even for unknown types", async () => {
  const p = await pairSessions(sig.url);
  try {
    const closed = once<[string]>(p.b, "close", 5000);
    (p.a as unknown as { send(f: object): void }).send({
      t: "custom", type: "x-unknown/large", payload: "x".repeat(LIMITS.customMessageBytes),
    });
    assert.match((await closed)[0], /custom message too large/);
  } finally { p.close(); }
});

test("a peer cannot exceed the inbound custom message rate limit", async () => {
  const p = await pairSessions(sig.url);
  try {
    const closed = once<[string]>(p.b, "close", 5000);
    const hostile = p.a as unknown as { send(f: object): void };
    for (let i = 0; i <= LIMITS.customMessagesPerMinute; i++) {
      hostile.send({ t: "custom", type: "x-hostile/ping", payload: i });
    }
    assert.match((await closed)[0], /custom message rate exceeded/);
  } finally { p.close(); }
});

test("patches need local consent, report conflicts, and apply cleanly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tincan-ws-"));
  await writeFile(path.join(root, "app.txt"), "v1\n");
  let decision = false;
  const p = await pairSessions(sig.url, {}, { workspaceRoot: root, onPatch: () => decision });
  try {
    const send = async (content: string) => {
      const done = once<[PatchOutcome]>(p.a, "patchOutcome");
      p.a.sendPatch(await createPatch(root, [{ path: "app.txt", content }]));
      return (await done)[0];
    };
    assert.equal((await send("v2\n")).status, "rejected");
    assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "v1\n");
    decision = true;
    const stale = await createPatch(root, [{ path: "app.txt", content: "from-a\n" }]);
    await writeFile(path.join(root, "app.txt"), "local edit\n");
    const conflict = once<[PatchOutcome]>(p.a, "patchOutcome");
    p.a.sendPatch(stale);
    const c = (await conflict)[0];
    assert.equal(c.status, "conflict");
    assert.equal(c.conflicts?.[0]?.reason, "changed");
    assert.equal((await send("v3\n")).status, "applied");
    assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "v3\n");
  } finally { p.close(); }
});

test("a peer without a consent handler rejects every patch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tincan-ws-"));
  const p = await pairSessions(sig.url, {}, { workspaceRoot: root });
  try {
    const done = once<[PatchOutcome]>(p.a, "patchOutcome");
    p.a.sendPatch({ files: [{ path: "x.txt", content: "x", baseSha256: null }] });
    assert.equal((await done)[0].status, "rejected");
    await assert.rejects(readFile(path.join(root, "x.txt")));
  } finally { p.close(); }
});

test("malicious paths from a peer are rejected before the consent prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tincan-ws-"));
  let prompted = false;
  const p = await pairSessions(sig.url, {}, { workspaceRoot: root, onPatch: () => { prompted = true; return true; } });
  try {
    const done = once<[PatchOutcome]>(p.a, "patchOutcome");
    // bypass sendPatch's own validation to simulate a hostile peer
    (p.a as unknown as { send(f: object): void }).send({ t: "patch", id: "evil", patch: { files: [{ path: "../escape.txt", content: "x", baseSha256: null }] } });
    const [out] = await done;
    assert.equal(out.status, "rejected");
    assert.equal(prompted, false);
  } finally { p.close(); }
});

test("presence goes offline when the peer goes silent and recovers", async () => {
  const p = await pairSessions(sig.url, { heartbeatMs: 100, offlineAfterMs: 400 }, { heartbeatMs: 100, offlineAfterMs: 400 });
  try {
    const quiet = p.b as unknown as { send(f: object): void };
    const realSend = quiet.send.bind(p.b);
    quiet.send = () => undefined;                  // b stops answering heartbeats
    assert.equal((await once<["online" | "offline"]>(p.a, "presence", 3000))[0], "offline");
    quiet.send = realSend;                         // b comes back
    assert.equal((await once<["online" | "offline"]>(p.a, "presence", 3000))[0], "online");
  } finally { p.close(); }
});

test("closing one side closes the other", async () => {
  const p = await pairSessions(sig.url);
  const closed = once(p.b, "close", 8000);
  p.a.close();
  await closed;
  assert.equal(p.links[1].isOpen, false);
});

test("replayed or out-of-order frames close the session", async () => {
  const p = await pairSessions(sig.url);
  try {
    const closed = once<[string]>(p.b, "close", 5000);
    p.links[0].send(Buffer.from(JSON.stringify({ seq: 1, t: "ping" })));   // seq 1 was already used by hello
    assert.match((await closed)[0], /sequence gap or replay/);
  } finally { p.close(); }
});

test("garbage, unknown types and oversize messages close the session", async () => {
  for (const frame of [Buffer.from("not json"), Buffer.from(JSON.stringify({ seq: 2, t: "exec", cmd: "id" }))]) {
    const p = await pairSessions(sig.url);
    const closed = once<[string]>(p.b, "close", 5000);
    p.links[0].send(frame);
    await closed;
    p.close();
  }
  const p = await pairSessions(sig.url);
  try {
    const closed = once(p.b, "close", 8000);
    assert.throws(() => p.links[0].send(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), /too large/);
    // a hostile peer streaming chunks beyond the cap without ever finishing a message
    const dc = (p.links[0] as unknown as { dc: { sendMessageBinary(b: Buffer): void } }).dc;
    for (let i = 0; i < 80; i++) dc.sendMessageBinary(Buffer.concat([Buffer.from([1]), Buffer.alloc(16_000)]));
    await closed;
  } finally { p.close(); }
});

test("large messages are chunked and reassembled intact", async () => {
  const p = await pairSessions(sig.url);
  try {
    const big = "é".repeat(30_000);
    const seen = once(p.b, "context");
    p.a.setContext("big", big.slice(0, 20_000));
    await seen;
    assert.equal((p.b.getContext("big") as string).length, 20_000);
    const raw = Buffer.alloc(300_000, 7);
    const got = once<[Buffer]>(p.links[1], "message");
    p.links[0].send(raw);
    assert.ok(Buffer.compare((await got)[0], raw) === 0);
  } finally { p.close(); }
});

test("an unanswered consent prompt times out and declines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tincan-ws-"));
  const p = await pairSessions(sig.url, {}, { workspaceRoot: root, consentTimeoutMs: 300, onPatch: () => new Promise<boolean>(() => undefined) });
  try {
    const done = once<[PatchOutcome]>(p.a, "patchOutcome");
    p.a.sendPatch({ files: [{ path: "x.txt", content: "x", baseSha256: null }] });
    const [out] = await done;
    assert.equal(out.status, "rejected");
    assert.match(out.note ?? "", /declined/);
    await assert.rejects(readFile(path.join(root, "x.txt")));
  } finally { p.close(); }
});

test("patches are handled one at a time, so a second patch sees the first one's result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tincan-ws-"));
  await writeFile(path.join(root, "f.txt"), "v0");
  const p = await pairSessions(sig.url, {}, { workspaceRoot: root, onPatch: () => true });
  try {
    const outcomes: PatchOutcome[] = [];
    p.a.on("patchOutcome", (o) => outcomes.push(o));
    const base = await createPatch(root, [{ path: "f.txt", content: "v1" }]);
    const rival = await createPatch(root, [{ path: "f.txt", content: "v2" }]);   // same base as the first
    p.a.sendPatch(base);
    p.a.sendPatch(rival);
    while (outcomes.length < 2) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ["applied", "conflict"]);
    assert.equal(await readFile(path.join(root, "f.txt"), "utf8"), "v1");
  } finally { p.close(); }
});

test("a peer's hello that arrives before the local session exists is not lost", async () => {
  const { host, join, Session } = await import("../src/index.js");
  const { ICE } = await import("./helpers.js");
  const h = await host({ signalingUrl: sig.url, ...ICE });
  const [guestLink, hostLink] = await Promise.all([join(h.code, { signalingUrl: sig.url, ...ICE }), h.connected]);
  const a = new Session(hostLink, { name: "early" });
  await new Promise((r) => setTimeout(r, 300));            // a's hello is now buffered on the guest link
  const b = new Session(guestLink, { name: "late" });
  try {
    const [peer] = await once<[{ name: string }]>(b, "ready");   // listener added right after construction
    assert.equal(peer.name, "early");
  } finally { a.close(); b.close(); }
});
