import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_EXTENSION_SOURCES,
  capabilityAvailability,
  extensionSourceEnabled,
  loadExtensionPolicy,
  setExtensionSourceEnabled,
} from "../electron/harness/extension-policy.js";

assert.deepEqual(MANAGED_EXTENSION_SOURCES, ["browser", "plugin", "skill", "mcp"]);
const root = await mkdtemp(join(tmpdir(), "aporiax-extension-policy-"));
try {
  const userDataDirectory = join(root, "user");
  const workspacePath = join(root, "workspace");
  await mkdir(join(workspacePath, ".aporiax"), { recursive: true });

  let policy = await loadExtensionPolicy({ userDataDirectory, workspacePath });
  assert.equal(policy.effective.browser, true);
  assert.equal(policy.effective.mcp, true);

  policy = await setExtensionSourceEnabled({
    userDataDirectory,
    source: "mcp",
    enabled: false,
  });
  assert.equal(policy.sources.mcp, false);
  assert.equal(extensionSourceEnabled(policy, "mcp"), false);

  await writeFile(
    join(workspacePath, ".aporiax", "extensions.json"),
    JSON.stringify({
      disabled: ["browser"],
      sources: { mcp: true },
      enable: ["mcp"],
    }),
    "utf8",
  );
  policy = await loadExtensionPolicy({ userDataDirectory, workspacePath });
  assert.equal(policy.sources.mcp, false);
  assert.equal(policy.effective.mcp, false, "project cannot re-enable a user-disabled source");
  assert.equal(policy.effective.browser, false);
  assert.deepEqual(policy.projectDisabled, ["browser"]);

  assert.deepEqual(
    capabilityAvailability({ source: "native" }, policy),
    { enabled: true, reason: "core-capability" },
  );
  assert.deepEqual(
    capabilityAvailability({ source: "mcp" }, policy),
    { enabled: false, reason: "disabled-by-user" },
  );
  assert.deepEqual(
    capabilityAvailability({ source: "browser" }, policy),
    { enabled: false, reason: "disabled-by-project" },
  );

  await assert.rejects(
    () => setExtensionSourceEnabled({ userDataDirectory, source: "native", enabled: false }),
    /Unsupported extension source/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("extension policy smoke: PASS");
