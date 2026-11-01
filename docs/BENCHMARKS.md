# Benchmarks

`npm run bench` measures this library on **loopback inside one process on one machine**. It is not a network benchmark: there is no real link, no packet loss, no NAT and no relay, and there is no relayed baseline yet (that comparison is on the roadmap). Do not read these numbers as what you will get between two machines.

Environment: Node v22, linux-x64, cloud sandbox VM.

How it measures:

- **Pairing**: 10 full pairings through a local signaling server (includes scrypt key derivation, ICE gathering and DTLS).
- **Round trip**: 200 echoes of a 64-byte message.
- **Bulk transfer**: 128 messages of 256 KiB (32 MiB of random data). The sender applies backpressure (waits while more than 1 MiB is queued). The receiver hashes every byte and sends the SHA-256 back; timing stops when the sender gets that ack, and the run fails if the hashes differ.

```json
{
  "node": "v22.23.4",
  "platform": "linux-x64",
  "transport": "loopback only, no STUN/TURN, no real network",
  "pairMs": {
    "runs": 10,
    "p50": 136.5,
    "max": 165
  },
  "rttMs": {
    "messages": 200,
    "payloadBytes": 64,
    "p50": 0.13,
    "p95": 0.19
  },
  "bulk": {
    "payloadBytes": 33554432,
    "messageBytes": 262144,
    "seconds": 0.32,
    "mbitPerSec": 838,
    "peakSenderBufferBytes": 1294804,
    "sendBackpressureLimitBytes": 1048576,
    "receiverHashVerified": true
  }
}
```

The bulk figure is one run on a shared VM, so treat it as the right order of magnitude only.

## Time to first task

`npm run demo` runs the CLI end to end (signaling server, host, join, context, task handoff, consented patch) as separate processes. On the same sandbox the first task arrived about 0.35 s after the demo started, including process start-up. The target "two agents pair and exchange a task in under a minute" is therefore **measured only on loopback**. Pairing between real machines depends on ICE and your signaling server and has not been measured by this project.
