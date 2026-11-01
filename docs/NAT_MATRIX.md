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
