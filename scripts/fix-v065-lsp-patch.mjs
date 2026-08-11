import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/patch-v065-lsp.mjs";
let content = await readFile(path, "utf8");
const beforeAnchor = `'    "test:github-workflow": "node tests/github-workflow-smoke.mjs",\\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",'`;
const beforeReplacement = `'    "test:github-workflow": "node tests/github-workflow-smoke.mjs",\\n    "test:lsp": "node tests/lsp-runtime-smoke.mjs",\\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",'`;
const afterAnchor = `'    "test:execution-wiring": "node tests/execution-mode-wiring-smoke.mjs",\\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",'`;
const afterReplacement = `'    "test:execution-wiring": "node tests/execution-mode-wiring-smoke.mjs",\\n    "test:lsp": "node tests/lsp-runtime-smoke.mjs",\\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",'`;
if (!content.includes(beforeAnchor) || !content.includes(beforeReplacement)) {
  throw new Error("LSP package-script patch anchors were not found.");
}
content = content.replace(beforeAnchor, afterAnchor).replace(beforeReplacement, afterReplacement);
const contextAssertion = '    2,\n    "LSP execute context",';
if (!content.includes(contextAssertion)) {
  throw new Error("LSP execute-context assertion was not found.");
}
content = content.replace(contextAssertion, '    1,\n    "LSP execute context",');
await writeFile(path, content, "utf8");
console.log("LSP patch adapted to execution foundation branch");
