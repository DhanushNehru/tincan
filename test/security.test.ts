import assert from "node:assert/strict";
import { test } from "node:test";
import { host, join, Session, type PatchOutcome, type Task } from "../src/index.js";
import { deriveKeys, seal } from "../src/pairing.js";
import { SignalingClient } from "../src/signaling/client.js";
import { ICE, once, startProxy, startSignaling } from "./helpers.js";

test("the signaling server never sees session content", async () => {
  const real = await startSignaling({ createsPerMinute: 1000 });
  const proxy = await startProxy(real.url);
  const secrets = ["SECRET-CONTEXT-5f3a9", "SECRET-TASK-7b21c", "SECRET-PATCH-e90d4"];
  try {
    const h = await host({ signalingUrl: proxy.url, ...ICE });
    const [gl, hl] = await Promise.all([join(h.code, { signalingUrl: proxy.url, ...ICE }), h.connected]);
    const a = new Session(hl, { name: "alpha" });
    const root = process.cwd();
    const b = new Session(gl, { name: "beta", workspaceRoot: root, onPatch: () => false });
    const gotTask = once<[Task]>(b, "task");
    const gotCtx = once(b, "context");
    const gotOutcome = once<[PatchOutcome]>(a, "patchOutcome");
    a.setContext("note", secrets[0]);
    a.handoff({ title: "t", instructions: secrets[1] as string });
    a.sendPatch({ files: [{ path: "p.txt", content: secrets[2] as string, baseSha256: null }] });
    await Promise.all([gotTask, gotCtx, gotOutcome]);
    assert.equal((await gotTask)[0].instructions, secrets[1]);
    const traffic = proxy.seen();
    assert.ok(traffic.length > 500, "proxy recorded the handshake");
    for (const s of secrets) {
      for (const form of [s, Buffer.from(s).toString("base64"), Buffer.from(s).toString("hex")]) {
        assert.equal(traffic.includes(form), false, `server saw ${s} as ${form.slice(0, 12)}`);
      }
    }
    assert.equal(traffic.includes("v=0"), false, "even the SDP is sealed");
    assert.equal(/a=fingerprint|a=candidate|127\.0\.0\.1:\d+ typ/.test(traffic.replace(/"url"/g, "")), false);
    a.close(); b.close();
  } finally { proxy.stop(); real.stop(); }
});

test("a server that alters the handshake blob breaks pairing", async () => {
  const real = await startSignaling({ createsPerMinute: 1000 });
  const proxy = await startProxy(real.url, (body) => {
    const parsed = JSON.parse(body) as { from: string; data: string };
    const raw = Buffer.from(parsed.data, "base64");
    raw[raw.length - 20] = (raw[raw.length - 20] ?? 0) ^ 0xff;
    return JSON.stringify({ ...parsed, data: raw.toString("base64") });
  });
  try {
    const h = await host({ signalingUrl: proxy.url, ...ICE, timeoutMs: 3000 });
    h.connected.catch(() => undefined);
    await assert.rejects(join(h.code, { signalingUrl: proxy.url, ...ICE }), /authentication/);
    await h.cancel();
  } finally { proxy.stop(); real.stop(); }
});

test("a server (or anyone) without the code cannot answer in the guest's place", async () => {
  const real = await startSignaling({ createsPerMinute: 1000 });
  try {
    const h = await host({ signalingUrl: real.url, ...ICE, timeoutMs: 6000 });
    const rejected = h.connected.then(() => "paired", (e: Error) => e.message);
    const room = deriveKeys(h.code).room;                // attacker is assumed to know even the room id
    const forger = new SignalingClient(real.url);
    const wrong = deriveKeys("0000-0000-0000");
    for (let i = 0; i < 3; i++) await forger.post(room, "guest", seal(wrong, "guest", { sdp: "v=0\r\na=fingerprint:sha-256 AA:BB\r\n", type: "answer" }));
    assert.match(await rejected, /code burned/);
  } finally { real.stop(); }
});

test("guessing codes is throttled and a guest with the wrong code fails", async () => {
  const real = await startSignaling({ missesPerMinute: 5 });
  try {
    const h = await host({ signalingUrl: real.url, ...ICE, timeoutMs: 4000 });
    h.connected.catch(() => undefined);
    const results: string[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(await join(`ABCD-EFGH-JK${i}0`, { signalingUrl: real.url, ...ICE }).then(() => "joined", (e: Error) => e.message));
    }
    assert.ok(results.every((r) => r !== "joined"));
    assert.ok(results.some((r) => /429/.test(r)), "throttled after the miss budget");
    await h.cancel();
  } finally { real.stop(); }
});
