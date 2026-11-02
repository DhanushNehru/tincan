import { readFileSync } from "node:fs";
const lines = readFileSync(new URL("../src/signaling/server.ts", import.meta.url), "utf8").split("\n").length - 1;
console.log(`signaling server: ${lines} lines`);
if (lines >= 300) { console.error("signaling server must stay under 300 lines"); process.exit(1); }
