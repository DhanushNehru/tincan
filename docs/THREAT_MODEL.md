# Threat model

This is what tincan defends against, what it does not, and what is tested. Last reviewed for v0.1.0. This is the author's own analysis. **It has not been independently audited**, and the tests below are evidence for specific scenarios, not a proof that no malicious server could ever read content.

## Assumptions

The guarantees hold only if: the pairing code stays secret until pairing completes; the operating system RNG is sound; Node's `crypto` (AES-256-GCM, scrypt, HKDF, HMAC) and libdatachannel's DTLS/SCTP stack are correct; and each peer's own machine is not compromised. If any of these fail, so do the claims.

## Transport facts

- Session traffic travels over a WebRTC **data channel**, which is protected by **DTLS** and carried over **SCTP**. (SRTP is for media streams and is not involved.)
- The WebRTC handshake (SDP offers and answers, which carry DTLS fingerprints and network addresses) travels through the signaling server. tincan **seals** each handshake blob with AES-256-GCM using a key derived from the pairing code, so the server cannot read or modify it.
- After the channel opens, each peer sends an HMAC tag over its role and both DTLS fingerprints, keyed from the pairing code. A peer that does not hold the code, or that sees different fingerprints, is dropped before any session message is processed.

"The server cannot read content" is not enough on its own. A malicious server could try to sit in the middle of the handshake or guess codes. The next sections cover those.

## Assets

1. Session content: context, task text, patches.
2. The integrity of files on each machine.
3. Each peer's network addresses (they are inside the SDP).

## Actors and what they can do

| Actor | Can | Cannot (tested unless noted) |
|---|---|---|
| Passive network observer | See that two hosts talk, volumes, timing | Read content (DTLS) |
| Signaling server operator | See room ids, blob sizes, timing, client IPs; refuse service | Read content or SDP (`test/security.test.ts` records every HTTP byte for one run and finds no secret strings and no SDP in the clear; this checks that the implementation does not leak, it does not prove the absence of other leaks); alter the handshake undetected (blob tampering test); answer in the guest's place without the code |
| Someone who guesses a code | Try; the server limits 404 lookups per IP per minute and the host burns the code after 3 invalid blobs | Succeed with meaningful probability: 60 bits of entropy, scrypt-stretched room id (guessing test covers throttling) |
| Someone who learns the code in time | Pair with the host as the guest | Nothing stops this. **The code is the credential.** Share it over a channel you trust and use it right away. |
| Malicious paired peer | Send any frame | Run commands (tincan never executes peer text), write files without local consent, escape the workspace, exhaust memory (size limits), replay frames (sequence numbers) |

## Pairing codes

- 12 characters of Crockford base32 = **60 bits**, generated with `crypto.randomInt`.
- The room id and keys come from `scrypt(code)` (N=2^15) then HKDF with separate labels, so the room id does not reveal the keys.
- Offline guessing by the server: it knows the room id and the sealed blobs, so it can test candidate codes by computing scrypt (about 65 ms per guess on the machine used for development, 32 MiB of memory each). 2^60 guesses is far beyond practical for one attacker; an attacker with large dedicated hardware is not modelled. This is the dominant cryptographic limit.
- Nonces: every sealed blob uses a fresh random 96-bit nonce under a key that is used for only a handful of blobs per code (at most 8 per room), so nonce reuse is not a practical concern.
- The confirmation tag is an HMAC over a version label, the room id, the sender's role and both DTLS fingerprints. Fingerprints are fresh for every connection, so a tag from one session cannot be replayed in another. This is a code-derived key, not a PAKE. Stronger designs are possible and welcome as future work.
- Rooms expire after 5 minutes (server and host). A host stops after 3 invalid answers.

## Peer identity

A peer is identified only as **"someone who knew this code during this pairing"**. There is no long-term identity, no key pinning, and no verification across sessions today. If your threat model needs to know the peer is a specific person across sessions, tincan does not provide it yet.

## Untrusted peer input

Every inbound frame is size-limited (1 MiB per message, 64 KiB per context value, 500 context keys, 50 pending tasks), schema-checked and must carry the next sequence number. A violation closes the session.

- **Tasks** are delivered as events. The library and CLI never run them. Whatever consumes the event decides what to do; an agent harness should treat the text as untrusted input from another party.
- **Patches** are applied only after your `onPatch` callback (or a CLI `consent` command) approves. The preview shown to the human is computed locally from your files, never taken from the sender. Paths must be relative, forward-slash, free of `..`, empty segments and `.git`, and may not resolve through symlinks outside the workspace. Patches are handled one at a time. Each file carries a hash of the sender's base; any mismatch is reported as a conflict and nothing is written. The hash is checked again just before each file is written, and if a write fails part-way the files already written are restored. An unanswered consent prompt declines after 2 minutes.
- **Local race limit:** between our path check and our write, another process on your machine that can modify the workspace (for example, replacing a directory with a symlink) could still redirect a write. A local attacker with workspace write access is out of scope. Patch limits: 100 files, 512 KiB.
- Without a `workspaceRoot` and `onPatch`, all patches are rejected.
- If your consent callback approves automatically, you have removed the safety. That is your decision to make.

## Replay and expiry

Frames carry a per-direction sequence number checked on arrival; a replayed or out-of-order frame closes the session. Handshake blobs are bound to the room and role, rooms are single use and expire, and a new code is generated for every host.

## Availability

The server can drop or delay anything. Rate limits and caps (rooms, blob size, blobs per room) bound its memory. Behind a reverse proxy, the per-IP limits see the proxy's address; see [self-hosting](SELF_HOSTING.md).

## Malicious signaling server: what it can still do

Drop, delay or reorder requests; post junk blobs (three bad blobs make the host abandon the code, so it can deny pairing); learn who pairs when and from which addresses; run unlimited offline guesses against the sealed blobs at the cost above. It cannot make either peer accept a handshake it altered or forged without the code.

## Established sessions

There is no maximum session lifetime or key rotation inside a session beyond what DTLS provides; close and re-pair for a new session. Memory use is bounded by the size limits above; timers and handlers are released when the link closes.

## Known gaps

- No key pinning or identity continuity (planned).
- Code-derived handshake key, not a PAKE.
- Peer IP addresses are visible to the other peer and to STUN/TURN servers you configure.
- No TURN support is shipped or tested; peers behind symmetric NATs may fail to connect ([NAT matrix](NAT_MATRIX.md)).
- Not audited by a third party.
