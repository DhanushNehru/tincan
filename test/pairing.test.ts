import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_ENTROPY_BITS, generateCode, normalizeCode } from "../src/index.js";
import { confirmTag, deriveKeys, open, sdpFingerprint, seal } from "../src/pairing.js";

test("codes have 60 bits, a stable format, and are not repeated", () => {
  const codes = new Set(Array.from({ length: 200 }, generateCode));
  assert.equal(codes.size, 200);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(CODE_ENTROPY_BITS, 60);
});

test("normalizeCode forgives case, spacing and O/I/L typos, and rejects junk", () => {
  assert.equal(normalizeCode("k7q2 m9xd 4tfr"), "K7Q2M9XD4TFR");
  assert.equal(normalizeCode("OIL0-0000-0000"), "011000000000");
  assert.throws(() => normalizeCode("short"));
  assert.throws(() => normalizeCode("UUUU-UUUU-UUUU"));
});

test("room id is derived, not the code, and keys are independent", () => {
  const k = deriveKeys("K7Q2-M9XD-4TFR");
  assert.match(k.room, /^[0-9a-f]{32}$/);
  assert.notEqual(k.signalKey.toString("hex"), k.confirmKey.toString("hex"));
  assert.equal(deriveKeys("k7q2m9xd4tfr").room, k.room);
  assert.notEqual(deriveKeys("K7Q2-M9XD-4TFS").room, k.room);
});

test("sealed blobs open only with the same code and role", () => {
  const k = deriveKeys("K7Q2-M9XD-4TFR");
  const blob = seal(k, "host", { sdp: "x" });
  assert.deepEqual(open(k, "host", blob), { sdp: "x" });
  assert.throws(() => open(k, "guest", blob), "role is bound");
  assert.throws(() => open(deriveKeys("K7Q2-M9XD-4TFS"), "host", blob), "wrong code");
  const tampered = Buffer.from(blob, "base64");
  tampered[20] = (tampered[20] ?? 0) ^ 1;
  assert.throws(() => open(k, "host", tampered.toString("base64")), "bit flip");
});

test("confirmation tags bind role and both fingerprints", () => {
  const k = deriveKeys("K7Q2-M9XD-4TFR");
  const t = confirmTag(k, "host", "AA", "BB");
  assert.notEqual(t, confirmTag(k, "guest", "AA", "BB"));
  assert.notEqual(t, confirmTag(k, "host", "AA", "CC"));
  assert.notEqual(t, confirmTag(deriveKeys("K7Q2-M9XD-4TFS"), "host", "AA", "BB"), "different code");
});

test("sdpFingerprint extracts the DTLS fingerprint", () => {
  assert.equal(sdpFingerprint("v=0\na=fingerprint:sha-256 ab:cd\n"), "AB:CD");
  assert.throws(() => sdpFingerprint("v=0\n"));
});
