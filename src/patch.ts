import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Limits applied to every incoming patch. */
export const PATCH_LIMITS = { files: 100, totalBytes: 512 * 1024, pathLength: 240 } as const;

/** One file change. `baseSha256` is the hash of the file the sender started from (`null` = file did not exist). */
export interface FileChange {
  /** Forward-slash path relative to the workspace root. */
  path: string;
  /** Full new UTF-8 content, or `null` to delete the file. */
  content: string | null;
  /** SHA-256 hex of the sender's base version, or `null` when creating a file. */
  baseSha256: string | null;
}

/** A set of file changes applied all-or-nothing. */
export interface Patch { files: FileChange[] }

/** Why a single file could not be applied. */
export interface Conflict { path: string; reason: "changed" | "exists" | "missing" | "unsafe-path" }

/** Outcome of {@link applyPatch}. */
export type ApplyResult = { ok: true; written: string[] } | { ok: false; conflicts: Conflict[] };

/** SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readIfExists(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/** Build a patch from edits, recording the current hash of each file under `root` as its base. */
export async function createPatch(root: string, edits: { path: string; content: string | null }[]): Promise<Patch> {
  const files: FileChange[] = [];
  for (const edit of edits) {
    const target = await resolveInside(root, edit.path);
    if (!target) throw new Error(`Unsafe path: ${edit.path}`);
    const base = await readIfExists(target);
    files.push({ path: edit.path, content: edit.content, baseSha256: base === null ? null : sha256(base) });
  }
  return { files };
}

/** Check the shape and size of a patch from an untrusted peer. Returns an error string or `null`. */
export function validatePatch(value: unknown): string | null {
  const files = (value as Patch | null)?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > PATCH_LIMITS.files) return "bad file count";
  let bytes = 0;
  const seen = new Set<string>();
  for (const f of files as Partial<FileChange>[]) {
    if (typeof f.path !== "string" || !isSafeRelative(f.path)) return `unsafe path`;
    if (seen.has(f.path)) return "duplicate path";
    seen.add(f.path);
    if (f.content !== null && typeof f.content !== "string") return "bad content";
    if (f.baseSha256 !== null && !(typeof f.baseSha256 === "string" && /^[0-9a-f]{64}$/.test(f.baseSha256))) return "bad base hash";
    bytes += f.content ? Buffer.byteLength(f.content) : 0;
  }
  return bytes > PATCH_LIMITS.totalBytes ? "patch too large" : null;
}

/** Lexical path check: relative, forward slashes, no `..`, no `.git`, no control characters. */
export function isSafeRelative(p: string): boolean {
  if (p.length === 0 || p.length > PATCH_LIMITS.pathLength || p.includes("\\") || /[\0-\x1f]/.test(p) || p.startsWith("/")) return false;
  const parts = p.split("/");
  return parts.every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** Resolve `rel` under `root`, refusing paths that escape through `..` or symlinks. Returns null if unsafe. */
async function resolveInside(root: string, rel: string): Promise<string | null> {
  if (!isSafeRelative(rel)) return null;
  const realRoot = await realpath(root);
  const target = path.join(realRoot, ...rel.split("/"));
  let dir = path.dirname(target);
  while (dir !== realRoot) {
    try {
      const real = await realpath(dir);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      dir = path.dirname(dir);
    }
  }
  try { if ((await lstat(target)).isSymbolicLink()) return null; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return target;
}

/** Compare a patch with the files under `root` without writing anything. */
export async function detectConflicts(root: string, patch: Patch): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  for (const f of patch.files) {
    const target = await resolveInside(root, f.path);
    if (!target) { conflicts.push({ path: f.path, reason: "unsafe-path" }); continue; }
    const current = await readIfExists(target);
    if (f.baseSha256 === null) { if (current !== null) conflicts.push({ path: f.path, reason: "exists" }); continue; }
    if (current === null) conflicts.push({ path: f.path, reason: "missing" });
    else if (sha256(current) !== f.baseSha256) conflicts.push({ path: f.path, reason: "changed" });
  }
  return conflicts;
}

/**
 * Apply a patch under `root`, all or nothing. Any file whose current content differs
 * from the sender's base is reported as a conflict and nothing is written. If a write fails
 * part-way, files already written are restored and the error is thrown.
 * Limits: a local process that can modify the workspace concurrently (for example swap a directory
 * for a symlink between our check and our write) is out of scope; see docs/THREAT_MODEL.md.
 * Callers must obtain local consent first; this function does not ask.
 */
export async function applyPatch(root: string, patch: Patch): Promise<ApplyResult> {
  const problem = validatePatch(patch);
  if (problem) return { ok: false, conflicts: [{ path: "*", reason: "unsafe-path" }] };
  const conflicts = await detectConflicts(root, patch);
  if (conflicts.length > 0) return { ok: false, conflicts };
  const written: string[] = [];
  const undo: { target: string; before: string | null }[] = [];
  try {
    for (const f of patch.files) {
      const target = await resolveInside(root, f.path);
      if (!target) throw new Error("path became unsafe");
      const before = await readIfExists(target);
      // Re-check the base immediately before touching the file, to narrow the window after detectConflicts.
      if ((f.baseSha256 === null) !== (before === null) || (before !== null && sha256(before) !== f.baseSha256)) throw new Error(`${f.path} changed during apply`);
      undo.push({ target, before });
      if (f.content === null) await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.tincan-${randomBytes(4).toString("hex")}`;
        await writeFile(tmp, f.content, { flag: "wx" });
        await rename(tmp, target);
      }
      written.push(f.path);
    }
  } catch (err) {
    for (const u of undo.reverse()) {
      if (u.before === null) await rm(u.target, { force: true }).catch(() => undefined);
      else await writeFile(u.target, u.before).catch(() => undefined);
    }
    throw err;
  }
  return { ok: true, written };
}

/** Line-based unified diff (original LCS implementation) for showing a human what a patch would change. */
export function unifiedDiff(file: string, before: string | null, after: string | null): string {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) return `--- ${file}\n+++ ${file}\n@@ file too large to diff line by line @@\n`;
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out = [`--- ${before === null ? "/dev/null" : "a/" + file}`, `+++ ${after === null ? "/dev/null" : "b/" + file}`];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  return out.join("\n") + "\n";
}

/** Render a human-readable preview of what applying `patch` under `root` would do. */
export async function previewPatch(root: string, patch: Patch): Promise<string> {
  const parts: string[] = [];
  for (const f of patch.files) {
    const target = await resolveInside(root, f.path);
    const current = target ? await readIfExists(target) : null;
    parts.push(unifiedDiff(f.path, current, f.content));
  }
  return parts.join("\n");
}
