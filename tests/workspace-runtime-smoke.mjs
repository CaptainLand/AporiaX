import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateLineChanges,
  getVerifiedWorkspaceRoot,
  isPathInside,
  resolveWorkspacePath,
  runGitCommand,
  searchWorkspaceText,
  verifyExistingTarget,
  verifyWritableTarget,
} from "../electron/runtime/workspace-runtime.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-workspace-runtime-"));
try {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.js"), "const Alpha = 1;\nconst beta = 2;\n", "utf8");

  const verifiedRoot = await getVerifiedWorkspaceRoot(root);
  assert.equal(verifiedRoot, root);
  assert.equal(isPathInside(root, join(root, "src", "a.js")), true);
  assert.equal(isPathInside(root, join(root, "..", "outside")), false);
  assert.throws(() => resolveWorkspacePath(root, "../outside"), /escapes/i);
  assert.equal(await verifyExistingTarget(root, "src/a.js"), join(root, "src", "a.js"));
  assert.equal(await verifyWritableTarget(root, "src/new.js"), join(root, "src", "new.js"));

  assert.deepEqual(calculateLineChanges("a\nb\n", "a\nc\n"), {
    additions: 1,
    deletions: 1,
  });

  const search = await searchWorkspaceText({
    workspaceRoot: root,
    requestedPath: "src",
    query: "alpha",
    caseSensitive: false,
    maxResults: 20,
    signal: new AbortController().signal,
  });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].path, "src/a.js");
  assert.equal(search.results[0].line, 1);

  const git = await runGitCommand({
    args: ["--version"],
    cwd: root,
    signal: new AbortController().signal,
  });
  assert.equal(git.exitCode, 0);
  assert.match(git.stdout, /git version/i);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("workspace runtime smoke: PASS");
