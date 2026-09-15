import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extensionLibrarySnapshot,
  importMcpConfiguration,
  importUserSkill,
  installCatalogSkill,
  removeMcpServer,
  removeUserSkill,
  saveMcpServer,
} from "../electron/extension-library.js";

const userDataDirectory = await mkdtemp(join(tmpdir(), "aporiax-library-"));
try {
  const initial = await extensionLibrarySnapshot({ userDataDirectory });
  const wordEditor = initial.catalog.entries.find(
    (entry) => entry.id === "skill.hermes-docx",
  );
  assert(wordEditor);
  assert.equal(wordEditor.titleZh, "Word 编辑与模板填充");
  assert.match(wordEditor.descriptionEn, /Python/);
  assert(initial.catalog.entries.some((entry) => entry.type === "mcp-template"));
  assert(!initial.catalog.entries.some((entry) => entry.id === "skill.bug-investigation"));
  assert(!initial.catalog.entries.some((entry) => ["mcp.remote-http", "mcp.local-stdio"].includes(entry.id)));
  assert(initial.catalog.entries.some((entry) => entry.id === "skill.systematic-debugging"));
  const playwrightTemplate = initial.catalog.entries.find((entry) => entry.id === "mcp.playwright");
  assert.deepEqual(playwrightTemplate.template.args, ["-y", "@playwright/mcp@0.0.81"]);

  const installed = await installCatalogSkill({
    userDataDirectory,
    catalogId: "skill.hermes-docx",
  });
  assert.equal(installed.installed, true);
  assert.match(await readFile(installed.path, "utf8"), /name: hermes-docx/);
  const afterSkill = await extensionLibrarySnapshot({ userDataDirectory });
  assert(afterSkill.installed.skillNames.includes("hermes-docx"));

  const customSkill = join(userDataDirectory, "custom-source");
  await mkdir(customSkill, { recursive: true });
  await writeFile(join(customSkill, "SKILL.md"), `---\nname: repo-guide\ntitle: Repo Guide\ndescription: Guide this repository.\nauto: false\n---\n\nUse repository evidence.\n`, "utf8");
  await writeFile(join(customSkill, "reference.md"), "# Reference\n", "utf8");
  const importedSkill = await importUserSkill({ userDataDirectory, sourceDirectory: customSkill });
  assert.equal(importedSkill.skill.name, "repo-guide");
  assert.equal(importedSkill.files, 2);
  const afterImport = await extensionLibrarySnapshot({ userDataDirectory });
  assert(afterImport.installed.skillNames.includes("repo-guide"));

  const mcpImportPath = join(userDataDirectory, "mcp-import.json");
  await writeFile(mcpImportPath, JSON.stringify({ mcpServers: { docs: { command: "node", args: ["server.js"] } } }), "utf8");
  const importedMcp = await importMcpConfiguration({ userDataDirectory, sourcePath: mcpImportPath });
  assert.equal(importedMcp.imported[0].id, "docs");

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
  assert(afterMcp.installed.mcpServers.some((server) => server.id === "demo_http"));
  assert(!JSON.stringify(afterMcp.installed).includes("Bearer"), "installed snapshot must not expose private header values (catalog examples are public)");
  assert(afterMcp.installed.mcpServers.find((server) => server.id === "demo_http").missingEnvironment.includes("MCP_TOKEN"));

  await removeMcpServer({ userDataDirectory, id: "demo_http" });
  await removeUserSkill({ userDataDirectory, name: "hermes-docx" });
  await removeMcpServer({ userDataDirectory, id: "docs" });
  await removeUserSkill({ userDataDirectory, name: "repo-guide" });
  const empty = await extensionLibrarySnapshot({ userDataDirectory });
  assert.equal(empty.installed.mcpServers.length, 0);
  assert.equal(empty.installed.skillNames.length, 0);
} finally {
  await rm(userDataDirectory, { recursive: true, force: true });
}

console.log("extension library smoke: PASS");
