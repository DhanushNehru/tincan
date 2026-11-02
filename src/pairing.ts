import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

/** Crockford base32 alphabet: no I, L, O, U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 12;

/** Entropy of a pairing code in bits (12 chars x 5 bits). */
export const CODE_ENTROPY_BITS = CODE_CHARS * 5;

/** Keys derived from a pairing code. The signaling server only ever sees `room`. */
export interface PairingKeys {
  /** Public rendezvous id, safe to send to the signaling server. */
  room: string;
  /** AES-256-GCM key protecting the handshake blobs. Never leaves the peer. */
  signalKey: Buffer;
  /** HMAC key used for the post-connect channel binding. Never leaves the peer. */
  confirmKey: Buffer;
}

/** Generate a fresh single-use pairing code, shown as `XXXX-XXXX-XXXX`. */
export function generateCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_CHARS; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Normalise user input: case, dashes, spaces and the usual O/I/L typos. Throws on a malformed code. */
export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (raw.length !== CODE_CHARS || [...raw].some((c) => !ALPHABET.includes(c))) {
    throw new Error("Invalid pairing code: expected 12 characters like K7Q2-M9XD-4TFR");
  }
  return raw;
}

/** Stretch a code with scrypt, then split it into independent room / encryption / confirmation keys. */
export function deriveKeys(code: string): PairingKeys {
  const master = scryptSync(normalizeCode(code), "tincan/v1/salt", 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const expand = (info: string, len: number) => Buffer.from(hkdfSync("sha256", master, "", `tincan/v1/${info}`, len));
  return { room: expand("room", 16).toString("hex"), signalKey: expand("signal", 32), confirmKey: expand("confirm", 32) };
}

/** Seal a handshake payload (SDP) for the other peer. The room and role are authenticated, so blobs cannot be replayed across roles. */
export function seal(keys: PairingKeys, role: "host" | "guest", payload: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.signalKey, nonce);
  cipher.setAAD(Buffer.from(`${keys.room}|${role}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** Open a blob sealed by the peer in `role`. Throws if the blob was forged, altered, or made with a different code. */
export function open<T>(keys: PairingKeys, role: "host" | "guest", blob: string): T {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < 12 + 16) throw new Error("Handshake blob too short");
  const decipher = createDecipheriv("aes-256-gcm", keys.signalKey, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${keys.room}|${role}`));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const plain = Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

/** Pull the DTLS certificate fingerprint out of an SDP description. */
export function sdpFingerprint(sdp: string): string {
  const match = /^a=fingerprint:\S+\s+(\S+)/m.exec(sdp);
  if (!match?.[1]) throw new Error("SDP has no DTLS fingerprint");
  return match[1].toUpperCase();
}

/** Channel-binding tag: proves a peer holds the code and sees the same room, role and two DTLS fingerprints as we do. Fingerprints are fresh per connection, so tags never repeat across sessions. */
export function confirmTag(keys: PairingKeys, role: "host" | "guest", hostFp: string, guestFp: string): string {
  return createHmac("sha256", keys.confirmKey).update(`tincan/v1/confirm|${keys.room}|${role}|${hostFp}|${guestFp}`).digest("hex");
}

/** Constant-time comparison of two hex tags. */
export function tagsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
