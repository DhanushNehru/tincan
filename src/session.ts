import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Link } from "./link.js";
import { applyPatch, previewPatch, validatePatch, type Conflict, type Patch } from "./patch.js";

/** Protocol limits enforced on every received message. */
export const LIMITS = { keyLength: 128, keys: 500, valueBytes: 64 * 1024, textLength: 16 * 1024, pendingTasks: 50 } as const;

/** A context entry. Last writer wins by `(clock, by)`. */
export interface ContextEntry { value: unknown; clock: number; by: string }

/** A task one agent hands to the other. It is only ever *shown*, never executed, by this library. */
export interface Task { id: string; title: string; instructions: string; files?: string[] }

/** Reply to a task. */
export interface TaskReply { id: string; status: "accepted" | "declined" | "done" | "failed"; note?: string }

/** What the receiving side decided about a patch. */
export interface PatchOutcome { id: string; status: "applied" | "rejected" | "conflict"; conflicts?: Conflict[]; note?: string }

/** Presence of the remote peer as seen by heartbeats. */
export type Presence = "online" | "offline";

/** Options for {@link Session}. */
export interface SessionOptions {
  /** Stable name shown to the other peer. */
  name?: string;
  /** Directory patches are applied under. Without it every incoming patch is rejected. */
  workspaceRoot?: string;
  /**
   * Local consent gate for incoming patches. Receives a unified-diff preview computed locally from your files
   * (never taken from the sender). Return true to apply. If omitted, patches are rejected.
   */
  onPatch?: (info: { id: string; preview: string; files: string[] }) => boolean | Promise<boolean>;
  /** How long to wait for `onPatch` before declining, in ms. Default 120000. */
  consentTimeoutMs?: number;
  /** Heartbeat period in ms. Default 5000. */
  heartbeatMs?: number;
  /** Mark the peer offline after this much silence in ms. Default 3x heartbeat. */
  offlineAfterMs?: number;
}

type Frame = { seq: number; t: string; [k: string]: unknown };

/**
 * Agent-to-agent session on top of an authenticated {@link Link}: shared context, task handoff,
 * patch exchange and heartbeat presence. Every inbound frame is validated, sequence-checked and size-bounded;
 * a violation closes the session.
 */
export class Session extends EventEmitter {
  private sendSeq = 0;
  private recvSeq = 0;
  private clock = 0;
  private readonly id = randomUUID();
  private readonly ctx = new Map<string, ContextEntry>();
  private readonly tasks = new Map<string, Task>();
  private ended = false;
  private patchQueue: Promise<void> = Promise.resolve();
  private lastSeen = Date.now();
  private presence: Presence = "online";
  private readonly timers: NodeJS.Timeout[] = [];

  /**
   * Events: `ready` (peer said hello), `context` (key, entry, local), `task`, `taskReply`, `patchOutcome`,
   * `presence` ("online" | "offline") and `close` (reason).
   */
  override on(event: "ready", listener: (peer: { name: string }) => void): this;
  override on(event: "context", listener: (key: string, entry: ContextEntry, local: boolean) => void): this;
  override on(event: "task", listener: (task: Task) => void): this;
  override on(event: "taskReply", listener: (reply: TaskReply) => void): this;
  override on(event: "patchOutcome", listener: (outcome: PatchOutcome) => void): this;
  override on(event: "presence", listener: (state: Presence) => void): this;
  override on(event: "close", listener: (reason: string) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /** Start a session on an already-authenticated link. Sends the hello and begins heartbeats. Add event listeners in the same tick so no early event is missed. */
  constructor(private readonly link: Link, private readonly opts: SessionOptions = {}) {
    super();
    // Attach after the caller has had a chance to add its own listeners: the link replays frames that arrived early,
    // and replaying them inside this constructor would emit `ready`/`task` events nobody can hear yet.
    queueMicrotask(() => link.on("message", (data) => this.onMessage(data)));
    link.on("close", (reason) => this.shutdown(reason));
    const beat = opts.heartbeatMs ?? 5000;
    const offlineAfter = opts.offlineAfterMs ?? beat * 3;
    this.timers.push(setInterval(() => {
      this.send({ t: "ping" });
      const next: Presence = Date.now() - this.lastSeen > offlineAfter ? "offline" : "online";
      if (next !== this.presence) { this.presence = next; this.emit("presence", next); }
    }, beat));
    this.timers.forEach((t) => t.unref());
    this.send({ t: "hello", id: this.id, name: opts.name ?? "agent", ctx: Object.fromEntries(this.ctx) });
  }

  private send(frame: { t: string; [k: string]: unknown }): void {
    if (!this.link.isOpen) return;
    this.link.send(Buffer.from(JSON.stringify({ seq: ++this.sendSeq, ...frame })));
  }

  private fail(reason: string): void {
    this.link.close(`protocol violation: ${reason}`);
  }

  private shutdown(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.timers.splice(0).forEach(clearInterval);
    this.emit("close", reason);
  }

  private onMessage(data: Buffer): void {
    let frame: Frame;
    try { frame = JSON.parse(data.toString("utf8")) as Frame; } catch { return this.fail("not JSON"); }
    if (typeof frame !== "object" || frame === null || typeof frame.t !== "string") return this.fail("bad frame");
    if (frame.seq !== this.recvSeq + 1) return this.fail("sequence gap or replay");
    this.recvSeq = frame.seq;
    this.lastSeen = Date.now();
    if (this.presence === "offline") { this.presence = "online"; this.emit("presence", "online"); }
    switch (frame.t) {
      case "hello": return this.onHello(frame);
      case "ping": return this.send({ t: "pong" });
      case "pong": return;
      case "ctx": return this.onContext(frame.key, frame.entry);
      case "task": return this.onTask(frame.task);
      case "taskReply": return this.onTaskReply(frame);
      case "patch": this.patchQueue = this.patchQueue.then(() => this.onPatch(frame)); return;
      case "patchOutcome": return this.onPatchOutcome(frame);
      default: return this.fail(`unknown type`);
    }
  }

  private validEntry(key: unknown, entry: unknown): entry is ContextEntry {
    const e = entry as ContextEntry;
    return typeof key === "string" && key.length > 0 && key.length <= LIMITS.keyLength && typeof e === "object" && e !== null
      && Number.isSafeInteger(e.clock) && typeof e.by === "string" && e.by.length <= 64
      && Buffer.byteLength(JSON.stringify(e.value ?? null)) <= LIMITS.valueBytes;
  }

  private merge(key: string, entry: ContextEntry): void {
    const mine = this.ctx.get(key);
    const wins = !mine || entry.clock > mine.clock || (entry.clock === mine.clock && entry.by > mine.by);
    if (!wins || (!mine && this.ctx.size >= LIMITS.keys)) return;
    this.ctx.set(key, entry);
    this.clock = Math.max(this.clock, entry.clock);
    this.emit("context", key, entry, false);
  }

  private onHello(f: Frame): void {
    const entries = (f.ctx ?? {}) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(entries)) if (this.validEntry(key, entry)) this.merge(key, entry);
    this.emit("ready", { name: typeof f.name === "string" ? f.name.slice(0, 64) : "agent" });
  }

  private onContext(key: unknown, entry: unknown): void {
    if (!this.validEntry(key, entry)) return this.fail("bad context entry");
    this.merge(key as string, entry);
  }

  private onTask(raw: unknown): void {
    const t = raw as Task;
    const ok = typeof t?.id === "string" && t.id.length <= 64 && typeof t.title === "string" && t.title.length <= 200
      && typeof t.instructions === "string" && t.instructions.length <= LIMITS.textLength;
    if (!ok || this.tasks.size >= LIMITS.pendingTasks) return this.fail("bad or excessive task");
    const task: Task = { id: t.id, title: t.title, instructions: t.instructions };
    if (Array.isArray(t.files)) task.files = t.files.filter((x): x is string => typeof x === "string").slice(0, 100);
    this.tasks.set(task.id, task);
    this.emit("task", task);
  }

  private onTaskReply(f: Frame): void {
    const statuses = ["accepted", "declined", "done", "failed"];
    if (typeof f.id !== "string" || !statuses.includes(f.status as string)) return this.fail("bad task reply");
    const reply: TaskReply = { id: f.id, status: f.status as TaskReply["status"] };
    if (typeof f.note === "string") reply.note = f.note.slice(0, LIMITS.textLength);
    this.emit("taskReply", reply);
  }

  private async onPatch(f: Frame): Promise<void> {
    const id = typeof f.id === "string" ? f.id.slice(0, 64) : "?";
    const reply = (o: Omit<PatchOutcome, "id">) => this.send({ t: "patchOutcome", id, ...o });
    const problem = validatePatch(f.patch);
    if (problem) return reply({ status: "rejected", note: `invalid patch: ${problem}` });
    const patch = f.patch as Patch;
    const { workspaceRoot, onPatch } = this.opts;
    if (!workspaceRoot || !onPatch) return reply({ status: "rejected", note: "this peer does not accept patches" });
    try {
      const preview = await previewPatch(workspaceRoot, patch);
      const ask = Promise.resolve(onPatch({ id, preview, files: patch.files.map((x) => x.path) }));
      const limit = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.opts.consentTimeoutMs ?? 120_000).unref());
      if (!(await Promise.race([ask, limit]))) return reply({ status: "rejected", note: "declined by local user" });
      const result = await applyPatch(workspaceRoot, patch);
      reply(result.ok ? { status: "applied" } : { status: "conflict", conflicts: result.conflicts });
    } catch (err) {
      reply({ status: "rejected", note: `could not apply: ${(err as Error).message}`.slice(0, 200) });
    }
  }

  private onPatchOutcome(f: Frame): void {
    if (typeof f.id !== "string" || !["applied", "rejected", "conflict"].includes(f.status as string)) return this.fail("bad patch outcome");
    const out: PatchOutcome = { id: f.id, status: f.status as PatchOutcome["status"] };
    if (typeof f.note === "string") out.note = f.note.slice(0, 200);
    if (Array.isArray(f.conflicts)) out.conflicts = (f.conflicts as Conflict[]).slice(0, 100);
    this.emit("patchOutcome", out);
  }

  /** Set a shared context value. Replicated to the peer; last writer wins. */
  setContext(key: string, value: unknown): void {
    const entry: ContextEntry = { value, clock: ++this.clock, by: this.id };
    if (!this.validEntry(key, entry)) throw new Error("Context key or value out of bounds");
    this.ctx.set(key, entry);
    this.emit("context", key, entry, true);
    this.send({ t: "ctx", key, entry });
  }

  /** Read a shared context value, or `undefined`. */
  getContext(key: string): unknown {
    return this.ctx.get(key)?.value;
  }

  /** Snapshot of all shared context. */
  contextSnapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.ctx].map(([k, e]) => [k, e.value]));
  }

  /** Hand a task to the peer. Returns its id. The peer decides what to do; nothing runs automatically. */
  handoff(task: Omit<Task, "id">): string {
    const id = randomUUID();
    this.send({ t: "task", task: { ...task, id } });
    return id;
  }

  /** Answer a task received through the `task` event. */
  replyToTask(reply: TaskReply): void {
    this.tasks.delete(reply.id);
    this.send({ t: "taskReply", ...reply });
  }

  /** Offer a patch to the peer. Resolves with its decision via the `patchOutcome` event. Returns the patch id. */
  sendPatch(patch: Patch): string {
    const problem = validatePatch(patch);
    if (problem) throw new Error(`Invalid patch: ${problem}`);
    const id = randomUUID();
    this.send({ t: "patch", id, patch });
    return id;
  }

  /** Current presence of the peer. */
  get peerPresence(): Presence {
    return this.presence;
  }

  /** End the session and close the link. */
  close(): void {
    this.link.close("session closed");
  }
}
