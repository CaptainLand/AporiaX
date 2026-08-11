import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeToolExecutor } from "../electron/runtime/native-tool-executor.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-native-executor-"));
try {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.js"), "const a = 1;\nconst shared = true;\n", "utf8");
  await writeFile(join(root, "src", "b.js"), "export const b = 1;\n", "utf8");
  await writeFile(join(root, "src", "obsolete.js"), "obsolete\n", "utf8");

  const inside = (requested) => {
    const target = resolve(root, requested || ".");
    if (!target.startsWith(root)) throw new Error("outside workspace");
    return target;
  };
  const lineChanges = (before, after) => ({
    additions: before === after ? 0 : 1,
    deletions: before === after ? 0 : 1,
  });
  const executor = createNativeToolExecutor({
    verifyExistingTarget: async (_workspaceRoot, requested) => inside(requested),
    verifyWritableTarget: async (_workspaceRoot, requested) => inside(requested),
    searchWorkspaceText: async ({ query, requestedPath }) => ({
      query,
      path: requestedPath,
      results: [{ path: "src/a.js", line: 1, column: 7, preview: "const a = 1;" }],
      filesScanned: 1,
      truncated: false,
    }),
    calculateLineChanges: lineChanges,
    runGitCommand: async ({ args }) => ({
      exitCode: 0,
      stdout: args[0] === "status" ? "## main\n" : "diff --git a/src/a.js b/src/a.js\n",
      stderr: "",
    }),
    limits: {
      maxFileReadChars: 120_000,
      maxFileWriteChars: 200_000,
      maxDirectoryEntries: 200,
      maxCommandChars: 2_000,
      maxCommandOutputChars: 80_000,
      maxSearchResults: 200,
      maxPatchTextChars: 120_000,
      maxGitDiffChars: 120_000,
    },
  });

  const base = {
    toolCall: { function: { name: "read_file" } },
    workspaceRoot: root,
    signal: new AbortController().signal,
    sandboxExecutor: async ({ command }) => ({ exitCode: 0, stdout: `${command}: ok`, stderr: "" }),
    sandboxStatus: { localAvailable: true },
  };

  const read = await executor({ ...base, toolName: "read_file", input: { path: "src/a.js" } });
  assert.match(read.modelResult.content, /const a = 1/);
  assert.equal(read.modelResult.sha256.length, 64);

  const readLines = await executor({
    ...base,
    toolName: "read_file",
    input: { path: "src/a.js", start_line: 2, end_line: 2 },
  });
  assert.equal(readLines.modelResult.content, "const shared = true;");
  assert.equal(readLines.modelResult.startLine, 2);

  const readPage = await executor({
    ...base,
    toolName: "read_file",
    input: { path: "src/a.js", offset: 0, limit: 7 },
  });
  assert.equal(readPage.modelResult.content, "const a");
  assert.equal(readPage.modelResult.nextOffset, 7);

  const externalRead = await executor({
    ...base,
    toolName: "read_external_file",
    input: { path: join(root, "src", "a.js"), reason: "Test approved external read", limit: 12 },
  });
  assert.equal(externalRead.modelResult.external, true);
  assert.equal(externalRead.modelResult.content.length, 12);

  const search = await executor({
    ...base,
    toolName: "search_text",
    input: { path: "src", query: "const" },
  });
  assert.equal(search.modelResult.results[0].path, "src/a.js");

  const patched = await executor({
    ...base,
    toolName: "apply_patch",
    input: { path: "src/a.js", old_text: "const a = 1;", new_text: "const a = 2;" },
  });
  assert.equal(patched.change.path, "src/a.js");
  assert.match(await readFile(join(root, "src", "a.js"), "utf8"), /a = 2/);

  const unified = await executor({
    ...base,
    toolName: "apply_patch",
    input: {
      patch: [
        "--- a/src/a.js",
        "+++ b/src/a.js",
        "@@ -1,2 +1,2 @@",
        " const a = 2;",
        "-const shared = true;",
        "+const shared = false;",
        "--- a/src/b.js",
        "+++ b/src/b.js",
        "@@ -1 +1 @@",
        "-export const b = 1;",
        "+export const b = 2;",
        "",
      ].join("\n"),
    },
  });
  assert.equal(unified.changes.length, 2);
  assert.match(await readFile(join(root, "src", "a.js"), "utf8"), /shared = false/);
  assert.match(await readFile(join(root, "src", "b.js"), "utf8"), /b = 2/);

  const deleted = await executor({
    ...base,
    toolName: "apply_patch",
    input: { patch: "--- a/src/obsolete.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-obsolete\n" },
  });
  assert.equal(deleted.changes[0].afterMissing, true);
  await assert.rejects(() => access(join(root, "src", "obsolete.js")));

  const command = await executor({
    ...base,
    toolName: "run_command",
    input: { command: "npm test", cwd: "." },
  });
  assert.equal(command.modelResult.exitCode, 0);
  assert.match(command.modelResult.stdout, /npm test: ok/);

  const status = await executor({ ...base, toolName: "git_status", input: {} });
  assert.equal(status.modelResult.clean, true);

  const diff = await executor({ ...base, toolName: "git_diff", input: { path: "src/a.js" } });
  assert.match(diff.modelResult.diff, /diff --git/);

  await assert.rejects(
    () => executor({ ...base, toolName: "read_file", input: { path: "../secret" } }),
    /outside workspace/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("native tool executor smoke: PASS");
