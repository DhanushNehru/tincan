/** One opaque blob relayed by the signaling server. */
export interface SignalBlob { n: number; from: "host" | "guest"; data: string }

/** Thin fetch-based client for the signaling server's HTTP API. */
export class SignalingClient {
  private readonly base: string;

  /** @param baseUrl Signaling server URL, e.g. `http://localhost:8787`. */
  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    return fetch(`${this.base}${path}`, init);
  }

  /** Create a room. Throws if the id is taken or the server refuses. */
  async createRoom(room: string): Promise<void> {
    const res = await this.call("POST", `/v1/rooms/${room}`);
    if (res.status !== 201) throw new Error(`Signaling server refused the room (HTTP ${res.status})`);
  }

  /** Post a blob into a room as `from`. */
  async post(room: string, from: "host" | "guest", data: string): Promise<void> {
    const res = await this.call("POST", `/v1/rooms/${room}/blobs`, { from, data });
    if (res.status !== 201) throw new Error(`Signaling server refused the blob (HTTP ${res.status})`);
  }

  /** Long-poll for blobs sent by `from` after sequence number `after`. Returns null when the room does not exist. */
  async poll(room: string, from: "host" | "guest", after: number, signal?: AbortSignal): Promise<{ blobs: SignalBlob[]; closed: boolean } | null> {
    const res = await this.call("GET", `/v1/rooms/${room}/blobs?from=${from}&after=${after}`, undefined, signal);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`Signaling poll failed (HTTP ${res.status})`);
    return (await res.json()) as { blobs: SignalBlob[]; closed: boolean };
  }

  /** Delete a room once the peers are connected. Best effort. */
  async deleteRoom(room: string): Promise<void> {
    await this.call("DELETE", `/v1/rooms/${room}`).catch(() => undefined);
  }
}
