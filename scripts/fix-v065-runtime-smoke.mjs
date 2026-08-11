import { readFile, writeFile } from "node:fs/promises";

const path = "tests/runtime-smoke.mjs";
const before = await readFile(path, "utf8");
const marker = 'const localSandboxResponses = [';
const start = before.indexOf(marker);
if (start < 0) throw new Error("Local sandbox runtime smoke block not found.");
const end = before.indexOf('const parallelRoot =', start);
if (end < 0) throw new Error("Local sandbox runtime smoke block end not found.");
const block = before.slice(start, end);
const occurrences = block.split('node --version').length - 1;
if (occurrences !== 2) throw new Error(`Expected 2 node --version assertions in local sandbox block, found ${occurrences}.`);
const nextBlock = block.replaceAll('node --version', 'npm test');
const after = before.slice(0, start) + nextBlock + before.slice(end);
await writeFile(path, after, "utf8");
console.log("runtime smoke aligned with smart permission allowlist");
