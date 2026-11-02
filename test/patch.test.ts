import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyPatch, createPatch, detectConflicts, isSafeRelative, previewPatch, sha256, unifiedDiff, validatePatch } from "../src/index.js";

const tmp = async () => mkdtemp(path.join(tmpdir(), "tincan-"));

test("isSafeRelative blocks traversal, absolute, .git and odd paths", () => {
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "a//b", ".git/config", "a/.GIT/x", "a\\b", "", "a/\0b", "./a"]) assert.equal(isSafeRelative(bad), false, bad);
  for (const ok of ["a.txt", "src/deep/file.ts", ".github/workflows/ci.yml"]) assert.equal(isSafeRelative(ok), true, ok);
});

test("validatePatch enforces shape and limits", () => {
  assert.equal(validatePatch({ files: [{ path: "a", content: "x", baseSha256: null }] }), null);
  assert.ok(validatePatch({ files: [] }));
  assert.ok(validatePatch({ files: [{ path: "../a", content: "x", baseSha256: null }] }));
  assert.ok(validatePatch({ files: [{ path: "a", content: "x", baseSha256: "nope" }] }));
  assert.ok(validatePatch({ files: [{ path: "a", content: "x", baseSha256: null }, { path: "a", content: "y", baseSha256: null }] }));
  assert.ok(validatePatch({ files: [{ path: "a", content: "x".repeat(600 * 1024), baseSha256: null }] }));
});

test("applies create, modify and delete together", async () => {
  const root = await tmp();
  await writeFile(path.join(root, "a.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "gone.txt"), "bye");
  const patch = await createPatch(root, [{ path: "a.txt", content: "one\nTWO\n" }, { path: "new/b.txt", content: "hello" }, { path: "gone.txt", content: null }]);
  const res = await applyPatch(root, patch);
  assert.deepEqual(res, { ok: true, written: ["a.txt", "new/b.txt", "gone.txt"] });
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "one\nTWO\n");
  assert.equal(await readFile(path.join(root, "new/b.txt"), "utf8"), "hello");
});

test("detects conflicts and writes nothing when any file conflicts", async () => {
  const root = await tmp();
  await writeFile(path.join(root, "a.txt"), "base");
  await writeFile(path.join(root, "exists.txt"), "mine");
  const patch = await createPatch(root, [{ path: "a.txt", content: "theirs" }, { path: "exists.txt", content: "x" }, { path: "fresh.txt", content: "ok" }]);
  await writeFile(path.join(root, "a.txt"), "edited locally");           // base moved on
  patch.files[1]!.baseSha256 = null;                                      // sender thought it was new
  patch.files.push({ path: "missing.txt", content: "z", baseSha256: sha256("was here") });
  const conflicts = await detectConflicts(root, patch);
  assert.deepEqual(conflicts.map((c) => `${c.path}:${c.reason}`), ["a.txt:changed", "exists.txt:exists", "missing.txt:missing"]);
  const res = await applyPatch(root, patch);
  assert.equal(res.ok, false);
  await assert.rejects(readFile(path.join(root, "fresh.txt")), "nothing written");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited locally");
});

test("refuses to write through symlinks that leave the workspace", async () => {
  const root = await tmp();
  const outside = await tmp();
  await symlink(outside, path.join(root, "link"));
  await mkdir(path.join(root, "real"));
  await symlink(path.join(outside, "target.txt"), path.join(root, "real", "f.txt"));
  const evil = { files: [{ path: "link/pwned.txt", content: "x", baseSha256: null }, { path: "real/f.txt", content: "x", baseSha256: null }] };
  const res = await applyPatch(root, evil);
  assert.equal(res.ok, false);
  await assert.rejects(readFile(path.join(outside, "pwned.txt")));
  await assert.rejects(readFile(path.join(outside, "target.txt")));
});

test("unifiedDiff and previewPatch show real changes", async () => {
  const d = unifiedDiff("f.txt", "a\nb\nc", "a\nB\nc");
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
  assert.match(d, /^ a$/m);
  const root = await tmp();
  await writeFile(path.join(root, "f.txt"), "a\nb");
  const preview = await previewPatch(root, await createPatch(root, [{ path: "f.txt", content: "a\nz" }]));
  assert.match(preview, /^\+z$/m);
});

test("a failed write rolls back files already written", async () => {
  const root = await tmp();
  await writeFile(path.join(root, "a.txt"), "original");
  // second change tries to create a file below a regular file, so it fails after the first one succeeded
  const patch = { files: [
    { path: "a.txt", content: "changed", baseSha256: sha256("original") },
    { path: "a.txt/child.txt", content: "x", baseSha256: null },
  ] };
  await assert.rejects(applyPatch(root, patch));
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "original");
});
