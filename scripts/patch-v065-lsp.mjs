import { readFile, writeFile } from "node:fs/promises";

async function edit(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Patch produced no change: ${path}`);
  await writeFile(path, after, "utf8");
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (content.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Ambiguous patch anchor: ${label}`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

function replaceExactCount(content, before, after, expected, label) {
  let count = 0;
  let cursor = 0;
  while ((cursor = content.indexOf(before, cursor)) >= 0) {
    count += 1;
    cursor += before.length;
  }
  if (count !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${count}`);
  return content.split(before).join(after);
}

await edit("electron/agent-core.js", (content) =>
  replaceExactCount(
    content,
    '    search_text: "allow",\n',
    '    search_text: "allow",\n    lsp: "allow",\n',
    3,
    "LSP permission policies",
  ),
);

const lspDefinition = `  {
    type: "function",
    function: {
      name: "lsp",
      description:
        "Use a persistent Language Server Protocol session for semantic code intelligence. Prefer LSP definition/references/hover/symbols over heuristic text search when semantic precision matters, and use diagnostics after code edits before final build/test verification.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["status", "diagnostics", "definition", "references", "hover", "document_symbols", "workspace_symbols"],
          },
          path: {
            type: "string",
            description: "Workspace-relative source file. Required for every operation except status; workspace_symbols uses it to select the language server.",
          },
          line: {
            type: "integer",
            minimum: 1,
            description: "1-based line for definition, references, or hover.",
          },
          character: {
            type: "integer",
            minimum: 1,
            description: "1-based character for definition, references, or hover.",
          },
          query: {
            type: "string",
            maxLength: 500,
            description: "Workspace symbol query. Empty string requests the server's broadest supported result.",
          },
          include_declaration: {
            type: "boolean",
            description: "Whether references should include the declaration. Defaults to true.",
          },
        },
        required: ["operation"],
        additionalProperties: false,
      },
    },
  },
`;

await edit("electron/runtime/native-tool-catalog.js", (content) => {
  content = replaceOnce(
    content,
    '  {\n    type: "function",\n    function: {\n      name: "run_command",',
    `${lspDefinition}  {\n    type: "function",\n    function: {\n      name: "run_command",`,
    "LSP tool definition",
  );
  content = replaceOnce(
    content,
    '  apply_patch: "write",\n  create_word_document: "write",',
    '  apply_patch: "write",\n  lsp: "read",\n  create_word_document: "write",',
    "LSP tool risk",
  );
  return content;
});

await edit("electron/runtime/native-tool-executor.js", (content) => {
  content = replaceOnce(
    content,
    '    browserRuntime = null,\n    processManager = null,',
    '    browserRuntime = null,\n    processManager = null,\n    lspManager = null,',
    "LSP executor context",
  );
  content = replaceOnce(
    content,
    '    if (toolName === "run_command") {',
    '    if (toolName === "lsp") {\n      if (!lspManager) throw new Error("LSP runtime is unavailable for this task.");\n      return { modelResult: await lspManager.execute(input) };\n    }\n\n    if (toolName === "run_command") {',
    "LSP executor handler",
  );
  return content;
});

await edit("electron/agent-runtime-core.js", (content) => {
  content = replaceOnce(
    content,
    'import { createPersistentProcessManager } from "./runtime/process-runtime.js";\n',
    'import { createPersistentProcessManager } from "./runtime/process-runtime.js";\nimport { createLspManager } from "./runtime/lsp-runtime.js";\n',
    "LSP manager import",
  );
  content = replaceOnce(
    content,
    '  const processManager = createPersistentProcessManager({ emit });\n  witness = createWitnessMonitor({ emit: forwardEvent });',
    '  const processManager = createPersistentProcessManager({ emit });\n  const lspManager = createLspManager({ workspaceRoot, emit, signal });\n  witness = createWitnessMonitor({ emit: forwardEvent });',
    "LSP manager lifecycle start",
  );
  content = replaceOnce(
    content,
    '        "Use search_text to locate relevant code before reading many files.",',
    '        "Use search_text to locate relevant code before reading many files.",\n        "Use the native lsp tool for semantic diagnostics, definitions, references, hover, and symbols when the file type has a configured language server. After code edits, prefer LSP diagnostics as a fast inner-loop signal, but still use build/tests for final verification.",',
    "LSP system prompt",
  );
  content = replaceExactCount(
    content,
    '                browserRuntime,\n                processManager,\n',
    '                browserRuntime,\n                processManager,\n                lspManager,\n',
    2,
    "LSP execute context",
  );
  content = replaceOnce(
    content,
    '  } finally {\n    await processManager.closeAll().catch(() => undefined);',
    '  } finally {\n    await lspManager.closeAll().catch(() => undefined);\n    await processManager.closeAll().catch(() => undefined);',
    "LSP lifecycle cleanup",
  );
  return content;
});

await edit("package.json", (content) => {
  content = replaceOnce(
    content,
    '    "test:github-workflow": "node tests/github-workflow-smoke.mjs",\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",',
    '    "test:github-workflow": "node tests/github-workflow-smoke.mjs",\n    "test:lsp": "node tests/lsp-runtime-smoke.mjs",\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",',
    "LSP test script",
  );
  content = replaceOnce(
    content,
    '      "node_modules/@vscode/ripgrep-*/**/*"\n    ],',
    '      "node_modules/@vscode/ripgrep-*/**/*",\n      "node_modules/typescript-language-server/**/*",\n      "node_modules/typescript/**/*"\n    ],',
    "LSP package asar unpack",
  );
  return content;
});

await edit(".github/workflows/ci.yml", (content) =>
  replaceOnce(
    content,
    '      - name: Tool permission smoke\n        run: npm run test:tool-permissions',
    '      - name: LSP smoke\n        run: npm run test:lsp\n\n      - name: Tool permission smoke\n        run: npm run test:tool-permissions',
    "LSP CI step",
  ),
);

await writeFile(
  "tests/lsp-runtime-smoke.mjs",
  `import assert from "node:assert/strict";\nimport { mkdtemp, rm, writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nimport { createLspManager } from "../electron/runtime/lsp-runtime.js";\n\nconst workspaceRoot = await mkdtemp(join(tmpdir(), "aporiax-lsp-smoke-"));\nconst filePath = join(workspaceRoot, "sample.ts");\nawait writeFile(\n  filePath,\n  [\n    "export const value: string = 123;",\n    "export const doubled = value + value;",\n    "",\n  ].join("\\n"),\n  "utf8",\n);\n\nconst events = [];\nconst manager = createLspManager({\n  workspaceRoot,\n  emit: (event) => events.push(event),\n});\ntry {\n  const initial = await manager.execute({ operation: "status" });\n  assert.ok(initial.supported.some((server) => server.id === "typescript" && server.bundled));\n\n  const diagnostics = await manager.execute({ operation: "diagnostics", path: "sample.ts" });\n  assert.equal(diagnostics.server, "typescript");\n  assert.ok(diagnostics.severityCounts.error >= 1, JSON.stringify(diagnostics));\n\n  const symbols = await manager.execute({ operation: "document_symbols", path: "sample.ts" });\n  assert.ok(Array.isArray(symbols.symbols));\n  assert.ok(symbols.symbols.length >= 1);\n\n  const hover = await manager.execute({ operation: "hover", path: "sample.ts", line: 2, character: 25 });\n  assert.equal(hover.server, "typescript");\n\n  const active = manager.status();\n  assert.equal(active.length, 1);\n  assert.equal(active[0].id, "typescript");\n  assert.ok(events.some((event) => event.type === "lsp.started"));\n} finally {\n  await manager.closeAll();\n  await rm(workspaceRoot, { recursive: true, force: true });\n}\n\nconsole.log("lsp runtime smoke: PASS");\n`,
  "utf8",
);

await edit("docs/releases/v0.6.5.md", (content) =>
  replaceOnce(
    content,
    '1. add a persistent LSP manager with diagnostics, definition, references, hover, document symbols, and workspace symbols;\n2. evolve long-running Safe/Isolated process backends',
    'The LSP slice adds a task-persistent native LSP manager and one semantic tool surface for status, diagnostics, definition, references, hover, document symbols, and workspace symbols. TypeScript/JavaScript uses a bundled language server; Python (Pyright), Rust (rust-analyzer), Go (gopls), and C/C++ (clangd) are discovered from the user environment. LSP remains a fast semantic inner loop and does not replace final build/test verification.\n\nThe remaining 0.6.5 work should continue with:\n\n1. evolve long-running Safe/Isolated process backends',
    "release LSP slice status",
  ),
);

console.log("v0.6.5 LSP wiring patch applied");
