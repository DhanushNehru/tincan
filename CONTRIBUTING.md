# Contributing

Thanks for helping. A few rules keep the project small and safe.

1. Open or claim an issue first for anything non-trivial. Issues labelled `good first issue` are a gentle start.
2. Original code only. Do not paste code from other projects or from snippets you cannot license under MIT.
3. Run `npm test`, `npm run lint`, `npm run typecheck` and `npm run check:signaling-size` before opening a PR.
4. Every exported API needs a TSDoc comment. Every behavior change needs a test.
5. The signaling server stays dependency-free and under 300 lines. It must never parse or log session content.
6. Security-relevant changes (pairing, framing, patch handling) need a note in `docs/THREAT_MODEL.md`.
7. Tests and examples use synthetic data only.

Report vulnerabilities privately through GitHub's security advisory form on this repository, not in a public issue.
