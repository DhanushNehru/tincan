#!/usr/bin/env node
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createPatch, createSignalingServer, host, join, Session, type Link, type LinkOptions } from "./index.js";

const USAGE = `tincan - direct, end-to-end encrypted agent-to-agent sessions

  tincan serve [--port 8787] [--bind 127.0.0.1]     run the signaling server
  tincan host  --server URL [options]               start a session, print a pairing code
  tincan join  CODE --server URL [options]          join with a code

options: --root DIR        workspace for incoming patches (omit to reject all patches)
         --name NAME       name shown to the peer
         --stun URL        STUN server (repeatable). Default: none, so LAN/loopback only
         --bind-address IP bind ICE to one local address

Sessions speak JSON lines: events on stdout, commands on stdin. See README.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8787" }, bind: { type: "string", default: "127.0.0.1" },
    server: { type: "string" }, root: { type: "string" }, name: { type: "string", default: "agent" },
    stun: { type: "string", multiple: true }, "bind-address": { type: "string" }, help: { type: "boolean", short: "h" },
  },
});

const emit = (event: string, data: object = {}) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
const die = (msg: string): never => { process.stderr.write(`${msg}\n`); return process.exit(1); };

function runSession(link: Link): void {
  const pending = new Map<string, (ok: boolean) => void>();
  const root = values.root;
  const session = new Session(link, {
    name: values.name,
    ...(root ? { workspaceRoot: root } : {}),
    // Patches are applied only after the local operator (or the agent harness driving stdin) sends {"cmd":"consent"}.
    onPatch: (info) => new Promise<boolean>((resolve) => {
      pending.set(info.id, resolve);
      emit("patch", info);
      setTimeout(() => { if (pending.delete(info.id)) resolve(false); }, 120_000).unref();
    }),
  });
  session.on("ready", (data) => emit("ready", data));
  session.on("task", (data) => emit("task", data));
  session.on("taskReply", (data) => emit("taskReply", data));
  session.on("patchOutcome", (data) => emit("patchOutcome", data));
  session.on("presence", (state) => emit("presence", { state }));
  session.on("context", (key, entry, local) => { if (!local) emit("context", { key, value: entry.value }); });
  session.on("close", (reason) => { emit("close", { reason }); process.exit(0); });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void (async () => {
      let cmd: Record<string, unknown>;
      try { cmd = JSON.parse(line) as Record<string, unknown>; } catch { return emit("error", { message: "stdin line is not JSON" }); }
      try {
        switch (cmd.cmd) {
          case "context": return void session.setContext(String(cmd.key), cmd.value);
          case "handoff": return emit("sent", { id: session.handoff({ title: String(cmd.title), instructions: String(cmd.instructions) }) });
          case "reply": return session.replyToTask({ id: String(cmd.id), status: cmd.status as "accepted" | "declined" | "done" | "failed", ...(cmd.note ? { note: String(cmd.note) } : {}) });
          case "patch": {
            if (!root) throw new Error("--root is required to create patches");
            return emit("sent", { id: session.sendPatch(await createPatch(root, cmd.edits as { path: string; content: string | null }[])) });
          }
          case "consent": {
            pending.get(String(cmd.id))?.(cmd.accept === true);
            return void pending.delete(String(cmd.id));
          }
          case "quit": return session.close();
          default: return emit("error", { message: "unknown cmd" });
        }
      } catch (err) { emit("error", { message: (err as Error).message }); }
    })();
  });
}

async function main(): Promise<void> {
  const [command, arg] = positionals;
  if (values.help || !command) return void console.log(USAGE);
  if (command === "serve") {
    const server = createSignalingServer();
    return void server.listen(Number(values.port), values.bind, () => emit("listening", { url: `http://${values.bind}:${(server.address() as { port: number }).port}` }));
  }
  if (!values.server) die("--server is required");
  const opts: LinkOptions = { signalingUrl: values.server as string };
  if (values.stun?.length) opts.iceServers = values.stun;
  if (values["bind-address"]) opts.bindAddress = values["bind-address"];
  if (command === "host") {
    const handle = await host(opts);
    emit("code", { code: handle.code });
    return runSession(await handle.connected);
  }
  if (command === "join" && arg) return runSession(await join(arg, opts));
  die(USAGE);
}

main().catch((err: Error) => die(`tincan: ${err.message}`));
