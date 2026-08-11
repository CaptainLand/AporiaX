import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extensionLibrarySnapshot,
  installCatalogSkill,
  removeMcpServer,
  removeUserSkill,
  saveMcpServer,
} from "../electron/extension-library.js";

const userDataDirectory = await mkdtemp(join(tmpdir(), "aporiax-library-"));
try {
  const initial = await extensionLibrarySnapshot({ userDataDirectory });
  const frontendReview = initial.catalog.entries.find(
    (entry) => entry.id === "skill.frontend-review",
  );
  assert(frontendReview);
  assert.equal(frontendReview.titleZh, "前端审阅");
  assert.match(frontendReview.descriptionEn, /accessibility/);
  assert(initial.catalog.entries.some((entry) => entry.type === "mcp-template"));

  const installed = await installCatalogSkill({
    userDataDirectory,
    catalogId: "skill.frontend-review",
  });
  assert.equal(installed.installed, true);
  assert.match(await readFile(installed.path, "utf8"), /name: frontend-review/);
  const afterSkill = await extensionLibrarySnapshot({ userDataDirectory });
  assert(afterSkill.installed.skillNames.includes("frontend-review"));

  await saveMcpServer({
    userDataDirectory,
    server: {
      id: "demo_http",
      name: "Demo HTTP",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${MCP_TOKEN}" },
      autoApproveReadOnly: true,
    },
  });
  const afterMcp = await extensionLibrarySnapshot({ userDataDirectory });
  assert.equal(afterMcp.installed.mcpServers[0].id, "demo_http");
  assert(!JSON.stringify(afterMcp).includes("MCP_TOKEN"), "public snapshot must not expose header values");

  await removeMcpServer({ userDataDirectory, id: "demo_http" });
  await removeUserSkill({ userDataDirectory, name: "frontend-review" });
  const empty = await extensionLibrarySnapshot({ userDataDirectory });
  assert.equal(empty.installed.mcpServers.length, 0);
  assert.equal(empty.installed.skillNames.length, 0);
} finally {
  await rm(userDataDirectory, { recursive: true, force: true });
}

console.log("extension library smoke: PASS");
