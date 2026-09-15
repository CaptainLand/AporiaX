// Opt-in network smoke. Downloads only to an isolated temporary user store;
// never starts third-party scripts or changes the real AporiaX configuration.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionDiscovery } from "../electron/extension-discovery.js";
const root = await mkdtemp(join(tmpdir(), "aporiax-live-discovery-"));
try {
  const service = createExtensionDiscovery();
  const skills = await service.search({ kind: "skill", query: "systematic-debugging" });
  const candidate = skills.entries.find((entry) => entry.source === "obra/superpowers");
  assert(candidate, "expected upstream Skill must exist in the live directory");
  const detail = await service.details(candidate.selector);
  const result = await service.install({ userDataDirectory: root, ticket: detail.ticket });
  assert.equal(result.verification.dependenciesVerified, false);
  assert.equal(result.verification.scriptsExecuted, false);
  const servers = await service.search({ kind: "mcp", query: "context7" });
  assert(servers.entries.length);
  const server = await service.details(servers.entries[0].selector);
  assert(server.choices.length);
  console.log(JSON.stringify({ skill: detail.name, commit: detail.version, license: detail.license, files: result.verification.fileCount, mcpSearchResults: servers.entries.length, mcpConnectionChoices: server.choices.length, thirdPartyProcessesStarted: false, realUserStoreChanged: false }));
} finally { await rm(root, { recursive: true, force: true }); }
