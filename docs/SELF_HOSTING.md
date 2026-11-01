# Self-hosting the signaling server

The server is `src/signaling/server.ts`: one file, no dependencies, under 300 lines (`npm run check:signaling-size`). It keeps rooms in memory only. Nothing is written to disk and request bodies are never logged.

## Run it

```bash
git clone https://github.com/DhanushNehru/tincan && cd tincan && npm install && npm run build && npm link   # Node 22+
tincan serve --port 8787 --bind 0.0.0.0
```

Or from a checkout: `npm run build && node dist/cli.js serve --port 8787`.

## Put TLS in front

The handshake blobs are sealed, so the server does not need TLS for confidentiality of content. Use TLS anyway so that room ids, timing and client addresses are not visible to the network, and so a network attacker cannot block or reorder requests. Any reverse proxy works, for example Caddy:

```
signal.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then pass `--server https://signal.example.com`.

## Rate limits behind a proxy

Limits are per client socket address. Behind a reverse proxy every client looks like the proxy, so the per-IP limits become global. Either rate-limit at the proxy and raise the defaults in code (`createSignalingServer({ createsPerMinute, missesPerMinute })`), or keep the defaults and accept the shared budget on a small private deployment.

## Tunables

`roomTtlMs` (5 min), `maxRooms` (2000), `maxBlobBytes` (32 KiB), `maxBlobsPerRoom` (8), `createsPerMinute` (10), `missesPerMinute` (20), `pollMs` (20 s).

## What the server learns

Room ids (a hash of the code), blob sizes, timing and client IP addresses. It does not learn the code, session content, or the SDP. See the [threat model](THREAT_MODEL.md).

## Relay (TURN)

tincan does not ship or test a relay. If peers cannot connect directly (for example behind symmetric NATs), a TURN server you run yourself would be needed; a self-host guide is on the roadmap. Passing TURN URLs is possible through `iceServers`, but that path is not tested yet.
