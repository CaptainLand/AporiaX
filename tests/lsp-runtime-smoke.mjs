import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLspManager } from "../electron/runtime/lsp-runtime.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "aporiax-lsp-smoke-"));
const filePath = join(workspaceRoot, "sample.ts");
await writeFile(
  filePath,
  [
    "export const value: string = 123;",
    "export const doubled = value + value;",
    "",
  ].join("\n"),
  "utf8",
);

const events = [];
const manager = createLspManager({
  workspaceRoot,
  emit: (event) => events.push(event),
});
try {
  const initial = await manager.execute({ operation: "status" });
  assert.ok(initial.supported.some((server) => server.id === "typescript" && server.bundled && server.available));
  assert.ok(initial.supported.some((server) => server.id === "python" && server.installable));

  const diagnostics = await manager.execute({ operation: "diagnostics", path: "sample.ts" });
  assert.equal(diagnostics.server, "typescript");
  assert.ok(diagnostics.severityCounts.error >= 1, JSON.stringify(diagnostics));

  const symbols = await manager.execute({ operation: "document_symbols", path: "sample.ts" });
  assert.ok(Array.isArray(symbols.symbols));
  assert.ok(symbols.symbols.length >= 1);

  const hover = await manager.execute({ operation: "hover", path: "sample.ts", line: 2, character: 25 });
  assert.equal(hover.server, "typescript");

  const active = manager.status();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "typescript");
  assert.ok(events.some((event) => event.type === "lsp.started"));
} finally {
  await manager.closeAll();
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("lsp runtime smoke: PASS");
