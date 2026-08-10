import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile("src/main.jsx", "utf8");
const hook = await readFile("src/hooks/useHarnessEvents.js", "utf8").catch(
  () => "",
);

assert.match(main, /useHarnessEvents\(\{/);
assert.doesNotMatch(main, /window\.desktop\?\.harness\?\.onEvent/);
assert.match(hook, /export function useHarnessEvents\(/);
assert.match(hook, /window\.desktop\?\.harness\?\.onEvent/);
assert.match(hook, /event\.type === "response\.delta"/);
assert.match(hook, /event\.type === "tool\.started"/);
assert.match(hook, /event\.type === "witness\.updated"/);
assert.match(hook, /event\.type === "approval\.required"/);
assert.match(hook, /event\.type === "skill\.activated"/);
assert.match(hook, /browser_open/);
assert.match(hook, /mcp__/);

console.log("Harness event hook smoke: PASS");
