import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const cli = path.resolve("dist/cli.js");

function run(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "inherit"] });
  const events: Record<string, unknown>[] = [];
  const waiters: { event: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    events.push(msg);
    const i = waiters.findIndex((w) => w.event === msg.event);
    if (i >= 0) waiters.splice(i, 1)[0]?.resolve(msg);
  });
  return {
    child,
    next: (event: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const hit = events.find((e) => e.event === event);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 15_000);
      waiters.push({ event, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    cmd: (o: object) => child.stdin.write(`${JSON.stringify(o)}\n`),
  };
}

test("CLI: two processes pair, hand off a task, and apply a consented patch", async () => {
  const bobWs = await mkdtemp(path.join(tmpdir(), "tincan-cli-"));
  const aliceWs = await mkdtemp(path.join(tmpdir(), "tincan-cli-"));
  for (const d of [bobWs, aliceWs]) await writeFile(path.join(d, "f.txt"), "a\n");
  const server = run(["serve", "--port", "0"]);
  const procs = [server];
  try {
    const { url } = (await server.next("listening")) as { url: string };
    const common = ["--server", url, "--bind-address", "127.0.0.1"];
    const alice = run(["host", ...common, "--root", aliceWs]);
    procs.push(alice);
    const { code } = (await alice.next("code")) as { code: string };
    const bob = run(["join", code, ...common, "--root", bobWs]);
    procs.push(bob);
    await Promise.all([alice.next("ready"), bob.next("ready")]);
    alice.cmd({ cmd: "handoff", title: "T", instructions: "do the thing" });
    assert.equal(((await bob.next("task")) as { title: string }).title, "T");
    alice.cmd({ cmd: "patch", edits: [{ path: "f.txt", content: "b\n" }] });
    const ask = (await bob.next("patch")) as { id: string; preview: string };
    assert.match(ask.preview, /^\+b$/m);
    assert.equal(await readFile(path.join(bobWs, "f.txt"), "utf8"), "a\n", "nothing applied before consent");
    bob.cmd({ cmd: "consent", id: ask.id, accept: true });
    assert.equal(((await alice.next("patchOutcome")) as { status: string }).status, "applied");
    assert.equal(await readFile(path.join(bobWs, "f.txt"), "utf8"), "b\n");
  } finally { procs.forEach((p) => p.child.kill()); }
});

test("CLI: prints usage and rejects a missing server", async () => {
  const out = await new Promise<string>((resolve) => {
    const c = spawn(process.execPath, [cli, "--help"]);
    let s = ""; c.stdout.on("data", (d: Buffer) => (s += d)); c.on("close", () => resolve(s));
  });
  assert.match(out, /tincan serve/);
});
