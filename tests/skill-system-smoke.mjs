import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkillRegistry,
  parseSkillDocument,
} from "../electron/harness/skills/registry.js";
import { prepareSkillRequest } from "../electron/skill-runtime.js";
import { parseWorkspaceMentions } from "../electron/workspace-mentions.js";

const parsed = parseSkillDocument(`---
name: translate-mod
title: MOD Translation
description: Translate localization files safely
auto: true
triggers:
  - translate
  - 翻译
tools: [read_file, write_file]
---
Keep localization keys unchanged.
`);
assert.equal(parsed.name, "translate-mod");
assert.deepEqual(parsed.triggers, ["translate", "翻译"]);
assert.deepEqual(parsed.tools, ["read_file", "write_file"]);
assert.match(parsed.instructions, /localization keys/);

assert.deepEqual(
  parseWorkspaceMentions("Use @skill translate-mod and inspect @src/main.jsx"),
  ["src/main.jsx"],
);

const root = await mkdtemp(join(tmpdir(), "aporiax-skills-"));
try {
  const userSkills = join(root, "user-skills");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await mkdir(join(userSkills, "translate-mod"), { recursive: true });
  await mkdir(join(workspaceA, ".aporiax", "skills", "frontend"), {
    recursive: true,
  });
  await mkdir(join(workspaceB, ".aporiax", "skills", "backend"), {
    recursive: true,
  });

  await writeFile(
    join(userSkills, "translate-mod", "SKILL.md"),
    `---
name: translate-mod
title: MOD Translation
description: Translation workflow
auto: true
triggers: [翻译, localization]
tools: [read_file, write_file]
---
Preserve keys and variables. Read the translation guide before editing.
`,
    "utf8",
  );
  await writeFile(
    join(workspaceA, ".aporiax", "skills", "frontend", "SKILL.md"),
    `---
name: frontend
title: Frontend Verification
auto: false
triggers: [frontend, UI]
tools: [read_file, run_command]
---
Inspect the current component and verify the build after editing.
`,
    "utf8",
  );
  await writeFile(
    join(workspaceB, ".aporiax", "skills", "backend", "SKILL.md"),
    `---
name: backend
title: Backend Safety
auto: true
triggers: [backend, API]
---
Validate server-side changes before delivery.
`,
    "utf8",
  );

  const registry = createSkillRegistry();
  const [catalogA, catalogB] = await Promise.all([
    registry.catalog({
      workspacePath: workspaceA,
      userSkillsDirectory: userSkills,
    }),
    registry.catalog({
      workspacePath: workspaceB,
      userSkillsDirectory: userSkills,
    }),
  ]);

  assert.deepEqual(
    catalogA.map((skill) => skill.name).sort(),
    ["frontend", "translate-mod"],
  );
  assert.deepEqual(
    catalogB.map((skill) => skill.name).sort(),
    ["backend", "translate-mod"],
  );
  assert.equal(catalogA.some((skill) => skill.name === "backend"), false);
  assert.equal(catalogB.some((skill) => skill.name === "frontend"), false);

  const automatic = registry.activate("帮我翻译 localization 文件", {
    catalog: catalogA,
  });
  assert.equal(automatic.skills[0].name, "translate-mod");
  assert.equal(automatic.skills[0].reason, "auto");

  const explicit = registry.activate("/skill:frontend 检查这个页面", {
    catalog: catalogA,
  });
  assert.equal(explicit.skills[0].name, "frontend");
  assert.equal(explicit.skills[0].reason, "explicit");

  const prepared = await prepareSkillRequest(
    {
      runId: "run-1",
      sourceUserId: "user-1",
      workspacePath: workspaceA,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "帮我翻译 localization 文件",
        },
      ],
    },
    {
      registry,
      userSkillsDirectory: userSkills,
    },
  );
  assert.equal(prepared.activatedSkills.length, 1);
  assert.equal(prepared.activatedSkills[0].name, "translate-mod");
  assert.equal(prepared.messages[0].role, "system");
  assert.equal(prepared.messages[0].skillContext, true);
  assert.match(prepared.messages[0].content, /Preserve keys and variables/);
  assert.match(prepared.messages[0].content, /do not grant additional permissions/i);
  assert.equal(prepared.messages[1].content, "帮我翻译 localization 文件");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("skill system smoke: PASS");
