# NAT traversal test matrix

Status key: **Tested** = run automatically or by hand with the evidence named. **Documented** = expected from how WebRTC works, written down but not run by this project. **Unverified** = we do not know.

| Scenario | Status | Evidence / expectation |
|---|---|---|
| Same host, loopback (two processes) | **Tested** | `npm test` and `npm run demo`; CI runs it on every push. |
| Same machine, two peers through a signaling proxy that records everything | **Tested** | `test/security.test.ts`. |
| Same LAN, two machines | **Unverified** | Host candidates should connect directly. Not run by this project yet. |
| Public STUN reachable, server-reflexive candidate gathered | **Tested (once, partial)** | From a cloud sandbox, gathering with `stun:stun.l.google.com:19302` produced a `srflx` candidate. This shows STUN works from there. It is **not** a two-peer, two-NAT connection test. |
| Two peers behind different cone NATs | **Unverified** | Expected to work with a STUN server (`--stun`). Needs two independent networks to confirm. |
| One or both peers behind symmetric NAT | **Documented** | Direct connection commonly fails and needs a TURN relay. Not tested. |
| Relay fallback (TURN) | **Documented** | tincan accepts ICE server URLs, so a self-run TURN server can be configured. No relay is shipped or tested; a self-host guide is on the roadmap. |
| Corporate networks that block UDP | **Documented** | Data channels use UDP-based ICE; expect failure without TURN over TCP/TLS. |

## How to contribute a real result

Start `tincan serve` on a public host, run `tincan host --stun ...` on one network and `tincan join` on another, and open an issue with the two NAT types (for example "home cable router" and "phone hotspot"), the outcome, and the time to connect. Use synthetic data only.

We have not simulated NATs in this repository. Results from network namespaces or similar tools would be labelled **simulated**, not real NAT proof.

## Runbook: a real two-machine, two-network run

This produces a result you can put in the table above. Use synthetic data only. Nothing here is automated, and the project has not run it yet.

1. Machine A and machine B must be on different networks (for example home Wi-Fi and a phone hotspot). Both need Node 22+ and `npm i -g tincan-agents` or a checkout of this repo (`npm ci && npm run build`).
2. Run the signaling server somewhere both can reach, over HTTPS if it is on the public internet (see `SELF_HOSTING.md`). The server only sees room ids, IPs, timing and sealed blobs.
3. On A: `tincan host --server URL --root ./a-dir --stun stun:stun.l.google.com:19302`. It prints a pairing code.
4. On B: `tincan join CODE --server URL --root ./b-dir --stun stun:stun.l.google.com:19302`.
5. Record the outcome. Connected means a `ready` event on both sides. Note the time from `join` to `ready`, then send a task handoff and a small patch to check data flows both ways.
6. Record each side's NAT type as best you know it (home router, carrier-grade NAT on a hotspot, corporate). Do not guess "symmetric"; if the connection fails, say only that it failed.
7. Open an issue titled "NAT result: <A network> to <B network>" with: tincan version, OS and Node version on each side, STUN servers used, outcome, time to connect.

Result template (copy into the issue):

| Field | Value |
|---|---|
| tincan version | |
| Peer A: OS / Node / network type | |
| Peer B: OS / Node / network type | |
| STUN / TURN used | |
| Outcome (connected / failed / timed out) | |
| Time from join to ready | |
| Handoff and patch exchanged both ways | |
| Notes | |

For a demo video of a real run, record both terminals side by side and say in the caption which networks were used.
