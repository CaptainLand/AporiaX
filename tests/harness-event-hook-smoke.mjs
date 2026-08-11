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
assert.match(hook, /event\.capability/);
assert.match(hook, /getRouteToolMeta/);
// Tool presentation must no longer depend on feature-specific MCP/browser name
// prefixes in the renderer. Older events remain supported by getRouteToolMeta.
assert.doesNotMatch(hook, /startsWith\("mcp__"\)/);
assert.doesNotMatch(hook, /startsWith\("browser_"\)/);

console.log("Harness event hook smoke: PASS");
