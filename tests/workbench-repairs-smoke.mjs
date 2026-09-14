import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hljs from "highlight.js/lib/common";
import { readWorkbenchFile } from "../electron/workbench/files.js";
import { highlightedRows } from "../src/workbench/code-preview.js";
import { normalizeLayout, persistableLayout } from "../src/workbench/state.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-workbench-test-"));
try {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const image = join(root, "external.png");
  await writeFile(image, Buffer.from("iVBORw0KGgo=", "base64"));
  await assert.rejects(readWorkbenchFile(workspace, image), /authorized workspace/);
  let prompts = 0;
  const allow = async (path) => { prompts++; assert.equal(path.toLowerCase(), image.toLowerCase()); return true; };
  assert.equal((await readWorkbenchFile(workspace, image, { authorizeExternal: allow })).kind, "image");
  await readWorkbenchFile(workspace, image, { authorizeExternal: allow });
  assert.equal(prompts, 2, "Each external read requires fresh approval");
  await assert.rejects(readWorkbenchFile(workspace, image, { authorizeExternal: async () => false }), /取消/);
  await writeFile(join(root, "external.txt"), "read only");
  const text = await readWorkbenchFile(workspace, join(root, "external.txt"), { authorizeExternal: async () => true });
  assert.equal(text.readOnly, true);
  assert.equal(text.content, "read only");
  const source = "/* first\nsecond */\nconst text = '<img onerror=alert(1)>';";
  const rows = highlightedRows(hljs.highlight(source, { language: "javascript" }).value);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal((row.match(/<span\b/g) || []).length, (row.match(/<\/span>/g) || []).length);
  assert.match(rows[1], /hljs-comment/);
  assert.ok(!rows.join("").includes("<img "));
  const layout = normalizeLayout({ tabs: [
    { kind: "file", id: "f", path: "src/MyComponent.jsx" },
    { kind: "image", id: "i", src: "data:image/png;base64,abc" },
    { kind: "image", id: "unsafe", src: "file:///C:/secret.png" },
  ] });
  assert.equal(layout.tabs[0].path, "src/MyComponent.jsx");
  assert.equal(layout.tabs.length, 2);
  assert.equal(persistableLayout(layout).tabs.length, 1);
  console.log("PASS: external preview denial/approval/cancellation/read-only, balanced syntax rows/XSS escaping, case preservation, safe transient images.");
} finally {
  // Only this test's newly created, named temporary directory is removed.
  await rm(root, { recursive: true, force: true });
}
