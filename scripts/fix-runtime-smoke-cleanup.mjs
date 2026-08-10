import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let source = await readFile("tests/runtime-smoke.mjs", "utf8");
source = replaceOnce(
  source,
  `import { join, resolve } from "node:path";`,
  `import { basename, join, resolve, sep } from "node:path";`,
  "path imports",
);
source = replaceOnce(
  source,
  `  if (!resolvedRoot.startsWith(\`${"${resolvedWorkspace}"}\\\\\`)) {\n    throw new Error("Refusing to remove a test directory outside the workspace.");\n  }`,
  `  if (\n    !resolvedRoot.startsWith(\`${"${resolvedWorkspace}"}${"${sep}"}\`) ||\n    !basename(resolvedRoot).startsWith(".runtime-smoke-")\n  ) {\n    throw new Error("Refusing to remove a test directory outside the workspace.");\n  }`,
  "runtime smoke cleanup guard",
);
await writeFile("tests/runtime-smoke.mjs", source, "utf8");
await rm("scripts/fix-runtime-smoke-cleanup.mjs", { force: true });
console.log("runtime smoke cleanup guard made cross-platform");
