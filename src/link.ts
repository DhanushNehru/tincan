import { EventEmitter } from "node:events";
import nodeDataChannel, { type DataChannel, type PeerConnection } from "node-datachannel";
import { confirmTag, deriveKeys, generateCode, open, sdpFingerprint, seal, tagsEqual, type PairingKeys } from "./pairing.js";
import { SignalingClient } from "./signaling/client.js";

const CHUNK = 16_000;
/** Largest single message a Link will reassemble. Bigger messages close the link. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_BAD_HANDSHAKES = 3;

/** Options shared by {@link host} and {@link join}. */
export interface LinkOptions {
  /** Signaling server base URL. */
  signalingUrl: string;
  /** STUN/TURN URLs. Default: none (LAN and loopback only). Add a STUN URL for cross-NAT use. */
  iceServers?: string[];
  /** Bind ICE candidates to one local address (useful for tests and multi-homed hosts). */
  bindAddress?: string;
  /** Give up on pairing after this many ms. Default 300000. */
  timeoutMs?: number;
}

/**
 * Message-oriented wrapper around one WebRTC data channel (DTLS over SCTP).
 * It splits messages into chunks, reassembles them within a size cap and
 * emits `message` and `close`. Use {@link host} or {@link join} to get one.
 */
export class Link extends EventEmitter {
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private closed = false;
  private early: Buffer[] = [];
  private gate?: { expected: string; done: (ok: boolean) => void };

  /** Listen for `message` (one whole message) or `close` (with a reason). */
  override on(event: "message", listener: (data: Buffer) => void): this;
  override on(event: "close", listener: (reason: string) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    if (event === "message") this.flush();
    return this;
  }

  /** Deliver messages that arrived before anyone was listening (the peer may speak first). */
  private flush(): void {
    for (let m = this.early.shift(); m; m = this.early.shift()) this.emit("message", m);
  }

  /** @internal */
  constructor(private readonly pc: PeerConnection, private readonly dc: DataChannel) {
    super();
    dc.onMessage((msg) => this.receive(typeof msg === "string" ? Buffer.from(msg) : Buffer.isBuffer(msg) ? msg : Buffer.from(msg)));
    dc.onClosed(() => this.close("data channel closed"));
    pc.onStateChange((state) => {
      if (state === "failed" || state === "disconnected" || state === "closed") this.close(`connection ${state}`);
    });
  }

  private receive(frame: Buffer): void {
    if (frame.length === 0) return;
    this.partialBytes += frame.length - 1;
    if (this.partialBytes > MAX_MESSAGE_BYTES) return this.close("message too large");
    this.partial.push(frame.subarray(1));
    if (frame[0] === 0) {
      const whole = Buffer.concat(this.partial);
      this.partial = [];
      this.partialBytes = 0;
      if (this.gate) {
        const { expected, done } = this.gate;
        this.gate = undefined;
        done(tagsEqual(whole.toString("utf8"), expected));
      } else if (this.listenerCount("message") === 0) {
        if (this.early.length < 100) this.early.push(whole);
      } else this.emit("message", whole);
    }
  }

  /**
   * Wait for the channel to open, swap key-confirmation tags with the peer and verify theirs.
   * Rejects (and closes the link) if the peer does not hold the pairing code or saw different DTLS fingerprints.
   * @internal
   */
  handshake(keys: PairingKeys, role: "host" | "guest", hostFp: string, guestFp: string, ms: number): Promise<void> {
    const theirs = confirmTag(keys, role === "host" ? "guest" : "host", hostFp, guestFp);
    return new Promise((resolve, reject) => {
      const fail = (why: string) => { this.close(why); reject(new Error(why)); };
      const timer = setTimeout(() => fail("Peer did not confirm in time"), ms);
      this.gate = { expected: theirs, done: (ok) => { clearTimeout(timer); if (ok) resolve(); else fail("Peer failed key confirmation (wrong code or tampered handshake)"); } };
      // The peer may confirm before this side starts waiting; that first frame was buffered as an early message.
      const early = this.early.shift();
      if (early) { const { done } = this.gate; this.gate = undefined; done(tagsEqual(early.toString("utf8"), theirs)); }
      const sendTag = () => this.dc.sendMessageBinary(Buffer.concat([Buffer.from([0]), Buffer.from(confirmTag(keys, role, hostFp, guestFp))]));
      if (this.dc.isOpen()) sendTag(); else this.dc.onOpen(sendTag);
    });
  }

  /** Send one message (up to {@link MAX_MESSAGE_BYTES}). Throws if the link is closed. */
  send(data: Buffer): void {
    if (this.closed) throw new Error("Link is closed");
    if (data.length > MAX_MESSAGE_BYTES) throw new Error("Message too large");
    for (let off = 0; off === 0 || off < data.length; off += CHUNK) {
      const part = data.subarray(off, off + CHUNK);
      const more = off + CHUNK < data.length ? 1 : 0;
      this.dc.sendMessageBinary(Buffer.concat([Buffer.from([more]), part]));
    }
  }

  /** Bytes queued for sending but not yet handed to the network. */
  get bufferedBytes(): number {
    return this.closed ? 0 : this.dc.bufferedAmount();
  }

  /** Resolve once fewer than `maxBytes` are queued. Use between large sends to apply backpressure. */
  async drain(maxBytes = 1024 * 1024): Promise<void> {
    while (!this.closed && this.dc.bufferedAmount() > maxBytes) await new Promise((r) => setTimeout(r, 1));
  }

  /** Whether the link is still usable. */
  get isOpen(): boolean {
    return !this.closed;
  }

  /** Close the connection. Safe to call twice. */
  close(reason = "closed locally"): void {
    if (this.closed) return;
    this.closed = true;
    try { this.dc.close(); this.pc.close(); } catch { /* already torn down */ }
    this.emit("close", reason);
  }
}

function newConnection(name: string, opts: LinkOptions): PeerConnection {
  const config: nodeDataChannel.RtcConfig = { iceServers: opts.iceServers ?? [] };
  if (opts.bindAddress) config.bindAddress = opts.bindAddress;
  return new nodeDataChannel.PeerConnection(name, config);
}

function gathered(pc: PeerConnection, ms: number): Promise<{ sdp: string; type: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ICE gathering timed out")), ms);
    const finish = () => {
      const d = pc.localDescription();
      if (!d) return;
      clearTimeout(timer);
      resolve(d);
    };
    pc.onGatheringStateChange((s) => { if (s === "complete") finish(); });
    if (pc.gatheringState() === "complete") finish();
  });
}

/** A waiting host: share `code` out of band, then await `connected`. */
export interface HostHandle {
  /** Single-use pairing code to give to the guest. */
  code: string;
  /** Resolves with the encrypted link once a guest with the right code connects. */
  connected: Promise<Link>;
  /** Abort pairing and release the room. */
  cancel(): Promise<void>;
}

/** Start pairing as the host. Creates a room, then waits for a guest who knows the code. */
export async function host(opts: LinkOptions): Promise<HostHandle> {
  const code = generateCode();
  const keys = deriveKeys(code);
  const signaling = new SignalingClient(opts.signalingUrl);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const abort = new AbortController();
  await signaling.createRoom(keys.room);

  const pc = newConnection("host", opts);
  const link = new Link(pc, pc.createDataChannel("tincan"));
  const connected = (async () => {
    try {
      const offer = await gathered(pc, 15_000);
      await signaling.post(keys.room, "host", seal(keys, "host", offer));
      const deadline = Date.now() + timeoutMs;
      let after = 0, bad = 0;
      let answer: { sdp: string; type: string } | undefined;
      while (!answer) {
        if (Date.now() > deadline || abort.signal.aborted) throw new Error("Pairing timed out or was cancelled");
        const res = await signaling.poll(keys.room, "guest", after, abort.signal);
        if (!res || res.closed) throw new Error("Pairing room closed");
        for (const blob of res.blobs) {
          after = blob.n;
          try { answer = open(keys, "guest", blob.data); break; } catch {
            if (++bad >= MAX_BAD_HANDSHAKES) throw new Error("Too many invalid handshake attempts; code burned");
          }
        }
      }
      const guestFp = sdpFingerprint(answer.sdp);
      const confirmed = link.handshake(keys, "host", sdpFingerprint(offer.sdp), guestFp, 30_000);
      pc.setRemoteDescription(answer.sdp, answer.type as nodeDataChannel.DescriptionType);
      await confirmed;
      await signaling.deleteRoom(keys.room);
      return link;
    } catch (err) {
      link.close("pairing failed");
      await signaling.deleteRoom(keys.room);
      throw err;
    }
  })();
  connected.catch(() => undefined);
  return { code, connected, cancel: async () => { abort.abort(); link.close("cancelled"); await signaling.deleteRoom(keys.room); } };
}

/** Join a host's room with the pairing code and return the encrypted link. */
export async function join(code: string, opts: LinkOptions): Promise<Link> {
  const keys = deriveKeys(code);
  const signaling = new SignalingClient(opts.signalingUrl);
  const pc = newConnection("guest", opts);
  try {
    const res = await signaling.poll(keys.room, "host", 0);
    const blob = res?.blobs[0];
    if (!blob) throw new Error("No host is waiting for that code");
    let offer: { sdp: string; type: string };
    try { offer = open(keys, "host", blob.data); } catch { throw new Error("Handshake failed authentication (wrong code or tampered by the server)"); }
    const hostFp = sdpFingerprint(offer.sdp);
    const linkPromise = new Promise<Link>((resolve) => pc.onDataChannel((dc) => resolve(new Link(pc, dc))));
    pc.setRemoteDescription(offer.sdp, offer.type as nodeDataChannel.DescriptionType);
    const answer = await gathered(pc, 15_000);
    await signaling.post(keys.room, "guest", seal(keys, "guest", answer));
    const link = await linkPromise;
    await link.handshake(keys, "guest", hostFp, sdpFingerprint(answer.sdp), 30_000);
    return link;
  } catch (err) {
    pc.close();
    throw err;
  }
}
