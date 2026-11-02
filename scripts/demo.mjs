// Runs the real CLI end to end on this machine: signaling server + two agents, synthetic data only.
// Prints a timeline with measured timings. Usage: node scripts/demo.mjs [--quiet]
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const t0 = performance.now();
const stamp = () => `[${((performance.now() - t0) / 1000).toFixed(2)}s]`;
const say = (who, text) => console.log(`${stamp()} ${who.padEnd(7)} ${text}`);

function start(who, args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "inherit"] });
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const i = waiters.findIndex((w) => w.event === msg.event);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
  });
  process.on("exit", () => child.kill());
  return {
    child,
    next: (event) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${who}: timed out waiting for ${event}`)), 20_000);
      waiters.push({ event, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    }),
    cmd: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
  };
}

// each agent has its own checkout of the same synthetic project
const workspace = await mkdtemp(path.join(tmpdir(), "tincan-bob-"));
const aliceWs = await mkdtemp(path.join(tmpdir(), "tincan-alice-"));
for (const dir of [workspace, aliceWs]) await writeFile(path.join(dir, "greeting.txt"), "hello\n");
const server = start("server", ["serve", "--port", "0"]);
const { url } = await server.next("listening");
say("server", "signaling up (it only relays sealed handshake blobs)");

const common = ["--server", url, "--bind-address", "127.0.0.1"];
const alice = start("alice", ["host", ...common, "--name", "alice", "--root", aliceWs]);
const { code } = await alice.next("code");
say("alice", `pairing code ${code}`);
const bob = start("bob", ["join", code, ...common, "--name", "bob", "--root", workspace]);
await Promise.all([alice.next("ready"), bob.next("ready")]);
say("both", "paired over an encrypted WebRTC data channel");

alice.cmd({ cmd: "context", key: "goal", value: "make greeting friendlier" });
await bob.next("context");
say("bob", "received shared context: goal");

const taskSeen = bob.next("task");
alice.cmd({ cmd: "handoff", title: "Update greeting", instructions: "Change greeting.txt to say hello, world" });
const task = await taskSeen;
say("bob", `received task "${task.title}" (shown, never auto-run)`);
const taskTime = performance.now() - t0;
bob.cmd({ cmd: "reply", id: task.id, status: "accepted" });
await alice.next("taskReply");
say("alice", "task accepted");

const consent = bob.next("patch");
alice.cmd({ cmd: "patch", edits: [{ path: "greeting.txt", content: "hello, world\n" }] });
const ask = await consent;
say("bob", `patch awaiting local consent:\n${ask.preview.trimEnd().replace(/^/gm, "           ")}`);
const outcome = alice.next("patchOutcome");
bob.cmd({ cmd: "consent", id: ask.id, accept: true });
say("alice", `patch outcome: ${(await outcome).status}`);
await writeFile(path.join(aliceWs, "greeting.txt"), "hello, world\n"); // alice mirrors the change locally
say("bob", `greeting.txt now: ${JSON.stringify(await readFile(path.join(workspace, "greeting.txt"), "utf8"))}`);

// stale base: bob edits locally, alice sends a patch built from the old base
const conflictAsk = bob.next("patch");
alice.cmd({ cmd: "patch", edits: [{ path: "greeting.txt", content: "hi\n" }] });
const stale = await conflictAsk;
await writeFile(path.join(workspace, "greeting.txt"), "bob edited meanwhile\n");
const conflictOutcome = alice.next("patchOutcome");
bob.cmd({ cmd: "consent", id: stale.id, accept: true });
const result = await conflictOutcome;
say("alice", `second patch: ${result.status} (${result.conflicts?.map((c) => `${c.path}:${c.reason}`).join(", ")})`);

console.log(`\npair + first task delivered in ${(taskTime / 1000).toFixed(2)}s (includes process start-up)`);
alice.cmd({ cmd: "quit" });
await new Promise((r) => setTimeout(r, 500));
for (const p of [alice, bob, server]) p.child.kill();
process.exit(0);
