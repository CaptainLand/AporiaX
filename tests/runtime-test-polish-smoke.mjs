import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPermissionPolicy, getToolPermission } from "../electron/agent-core.js";
import { createHarnessKernel } from "../electron/harness/kernel.js";
import { tryReadExternalDirectory } from "../electron/runtime/external-read.js";

const readOnly = createPermissionPolicy("read-only");
const workspaceWrite = createPermissionPolicy("workspace-write");
const builderWrite = createPermissionPolicy("builder-write");

assert.equal(getToolPermission(readOnly, "read_external_file"), "allow");
assert.equal(getToolPermission(workspaceWrite, "read_external_file"), "allow");
assert.equal(getToolPermission(builderWrite, "read_external_file"), "deny");
assert.equal(getToolPermission(workspaceWrite, "write_file"), "allow");

const root = await mkdtemp(join(tmpdir(), "aporiax-external-read-"));
try {
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "alpha.txt"), "alpha", "utf8");
  const listing = await tryReadExternalDirectory(root);
  assert.equal(listing?.external, true);
  assert.equal(listing?.readOnly, true);
  assert.equal(listing?.kind, "directory");
  assert.ok(listing.entries.some((entry) => entry.name === "alpha.txt" && entry.type === "file"));
  assert.ok(listing.entries.some((entry) => entry.name === "folder" && entry.type === "directory"));

  const ordinaryFile = await tryReadExternalDirectory(join(root, "alpha.txt"));
  assert.equal(ordinaryFile, null, "ordinary files must continue through the existing external file reader");

  try {
    await symlink(join(root, "folder"), join(root, "link-to-folder"), "dir");
    await assert.rejects(
      () => tryReadExternalDirectory(join(root, "link-to-folder")),
      /symbolic link/i,
    );
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

const kernel = createHarnessKernel();
const skillNames = new Set(kernel.skills.list().map((skill) => skill.name));
for (const name of ["word-design", "spreadsheet-design", "presentation-design"]) {
  assert.ok(skillNames.has(name), `missing bundled Office skill: ${name}`);
}

const wordMatch = kernel.skills.activate("请帮我生成一份专业的 Word 报告");
assert.ok(wordMatch.skills.some((skill) => skill.name === "word-design"));
const excelMatch = kernel.skills.activate("做一个 Excel 统计表和报表");
assert.ok(excelMatch.skills.some((skill) => skill.name === "spreadsheet-design"));
const pptMatch = kernel.skills.activate("制作一个答辩 PPT 演示文稿");
assert.ok(pptMatch.skills.some((skill) => skill.name === "presentation-design"));

const css = await readFile(new URL("../src/test-feedback-polish.css", import.meta.url), "utf8");
assert.match(css, /\.self-check-card\s*\{[\s\S]*display:\s*none\s*!important/);
assert.match(css, /assistant-message:not\(:has\(\.aporiax-run-duration\.running\)\)[\s\S]*assistant-progress-journal/);
assert.match(css, /@container\s*\(max-width:\s*720px\)/);
assert.match(css, /\.model-menu-source-note/);

console.log("runtime production-test polish smoke: PASS");
