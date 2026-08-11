import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/patch-v065-github.mjs";
const before = await readFile(path, "utf8");
const target = 'args: ["log", "--oneline", "--decorate", `--max-count=${maxCount}`],';
const replacement = 'args: ["log", "--oneline", "--decorate", "--max-count=" + maxCount],';
if (!before.includes(target)) throw new Error("GitHub patch quoting target not found.");
const after = before.replace(target, replacement);
await writeFile(path, after, "utf8");
console.log("GitHub patch template quoting repaired");
