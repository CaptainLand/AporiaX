// Optional local dependency test: set TEST_PYTHON to a Python with python-docx/lxml.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
const python = process.env.TEST_PYTHON;
if (!python) throw new Error("Set TEST_PYTHON explicitly; this test never installs packages.");
const root = await mkdtemp(join(tmpdir(), "aporiax-hermes-"));
const scripts = resolve(process.env.TEST_HERMES_SCRIPTS || "electron/library/skills/hermes-docx/scripts");
function run(script, args) {
  const result = spawnSync(python, [join(scripts, script), ...args], { encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, `${script}: ${result.stdout} ${result.stderr}`); return result.stdout;
}
try {
  for (const script of ["docx_create.py", "docx_read.py", "docx_edit.py", "docx_template.py", "docx_revisions.py", "docx_comments.py", "docx_validate.py"]) run(script, ["--help"]);
  const spec = join(root, "spec.json"), original = join(root, "original.docx"), filled = join(root, "filled.docx"), edited = join(root, "edited.docx");
  await writeFile(spec, JSON.stringify({ header: "{{name}}", footer_page_numbers: true, blocks: [{ type: "heading", text: "中文模板", level: 1 }, { type: "paragraph", runs: [{ text: "Hello " }, { text: "{{na", bold: true }, { text: "me}}", italic: true }] }, { type: "table", header: ["客户", "状态"], rows: [["{{name}}", "完成"]] }] }));
  run("docx_create.py", [spec, original]);
  const before = await readFile(original);
  const values = join(root, "values.json"); await writeFile(values, JSON.stringify({ name: "AporiaX" }));
  run("docx_template.py", [original, values, filled, "--strict"]);
  run("docx_edit.py", ["replace", filled, "--find", "AporiaX", "--replace", "AporiaX Cloud", "-o", edited]);
  assert.equal(JSON.parse(run("docx_validate.py", [edited])).ok, true);
  assert.deepEqual(await readFile(original), before, "original must be preserved");
  const zip = await JSZip.loadAsync(await readFile(edited));
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /Hello /); assert.match(xml, /AporiaX Cloud/); assert.match(xml, /<w:b/); assert(!xml.includes("{{"));
  assert.match(await zip.file("word/header1.xml").async("string"), /AporiaX Cloud/);
  console.log("Hermes DOCX: 7 CLI entry points, split-run template filling, formatting-preserving edits, header/table replacement, original preservation and package validation: PASS (not visual QA)");
} finally { await rm(root, { recursive: true, force: true }); }
