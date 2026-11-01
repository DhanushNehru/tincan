import assert from "node:assert/strict";
import { test } from "node:test";
import { SignalingClient } from "../src/signaling/client.js";
import { startSignaling } from "./helpers.js";

const ROOM = "a".repeat(32);

test("room lifecycle: create, post, poll, delete", async () => {
  const s = await startSignaling({ pollMs: 200 });
  try {
    const c = new SignalingClient(s.url);
    await c.createRoom(ROOM);
    await assert.rejects(c.createRoom(ROOM), /409/);
    await c.post(ROOM, "host", "blob-1");
    const got = await c.poll(ROOM, "host", 0);
    assert.deepEqual(got?.blobs.map((b) => b.data), ["blob-1"]);
    assert.deepEqual((await c.poll(ROOM, "guest", 0))?.blobs, [], "other role sees nothing");
    await c.deleteRoom(ROOM);
    assert.equal(await c.poll(ROOM, "host", 0), null);
  } finally { s.stop(); }
});

test("long poll wakes when a blob arrives", async () => {
  const s = await startSignaling({ pollMs: 5000 });
  try {
    const c = new SignalingClient(s.url);
    await c.createRoom(ROOM);
    const waiting = c.poll(ROOM, "guest", 0);
    setTimeout(() => void c.post(ROOM, "guest", "late"), 50);
    assert.equal((await waiting)?.blobs[0]?.data, "late");
  } finally { s.stop(); }
});

test("rejects bad ids, oversize blobs and over-full rooms", async () => {
  const s = await startSignaling({ maxBlobBytes: 100, maxBlobsPerRoom: 2 });
  try {
    const c = new SignalingClient(s.url);
    await assert.rejects(c.createRoom("short"), /400/);
    await c.createRoom(ROOM);
    await assert.rejects(c.post(ROOM, "host", "x".repeat(101)), /400/);
    await c.post(ROOM, "host", "1");
    await c.post(ROOM, "host", "2");
    await assert.rejects(c.post(ROOM, "host", "3"), /429/);
  } finally { s.stop(); }
});

test("rate limits room creation and lookups of unknown rooms", async () => {
  const s = await startSignaling({ createsPerMinute: 3, missesPerMinute: 3 });
  try {
    const c = new SignalingClient(s.url);
    for (let i = 0; i < 3; i++) await c.createRoom(i.toString(16).padStart(32, "0"));
    await assert.rejects(c.createRoom("f".repeat(32)), /429/);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.url}/v1/rooms/${"b".repeat(31)}${i}/blobs`)).status);
    assert.deepEqual(codes, [404, 404, 404, 429, 429]);
  } finally { s.stop(); }
});

test("rooms expire", async () => {
  const s = await startSignaling({ roomTtlMs: 1 });
  try {
    const c = new SignalingClient(s.url);
    await c.createRoom(ROOM);
    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(await c.poll(ROOM, "host", 0), null);
  } finally { s.stop(); }
});
