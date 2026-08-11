import assert from "node:assert/strict";
import {
  createCapabilityRegistry,
  capabilityFromToolDescriptor,
} from "../electron/harness/capability-registry.js";
import {
  defaultCapabilityPresentation,
  publicToolCapability,
} from "../electron/harness/capability-presentation.js";

const registry = createCapabilityRegistry();
registry.register(
  capabilityFromToolDescriptor({
    definition: {
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
      },
    },
    risk: "read",
  }),
);
registry.register(
  capabilityFromToolDescriptor({
    definition: {
      function: {
        name: "browser_click",
        description: "Click a page element",
        parameters: { type: "object" },
      },
    },
    risk: "control",
    source: "browser",
  }),
);

const read = registry.describeTool("read_file", "work");
assert.equal(read.source, "native");
assert.equal(read.stage, "lens");
assert.equal(read.titleZh, "读取文件");
assert.equal(read.activityZh, "正在读取文件");
assert.equal(read.iconKey, "file-read");

const click = registry.describeTool("browser_click", "work");
assert.equal(click.source, "browser");
assert.equal(click.stage, "forge");
assert.equal(click.activityEn, "Clicking page element");

const verifyRead = registry.describeTool("read_file", "self-check");
assert.equal(verifyRead.stage, "trial");

registry.upsert({
  id: "mcp:run-1:tool:mcp:github:mcp__github__create_issue",
  kind: "tool",
  source: "mcp",
  name: "mcp__github__create_issue",
  title: "Create issue",
  risk: "control",
  scopeId: "mcp:run-1",
  serverId: "github",
});
const mcp = registry.describeTool("mcp__github__create_issue", "work");
assert.equal(mcp.source, "mcp");
assert.equal(mcp.stage, "forge");
assert.equal(mcp.activityZh, "正在调用 MCP · Create issue");
assert.equal(mcp.serverId, "github");

const unknownPresentation = defaultCapabilityPresentation({
  name: "custom_tool",
  title: "Custom Tool",
  source: "plugin",
  risk: "execute",
});
assert.equal(unknownPresentation.stage, "trial");
assert.equal(unknownPresentation.activityEn, "Running Custom Tool");

const publicMeta = publicToolCapability(
  registry.find({ kind: "tool", name: "mcp__github__create_issue" }),
  "work",
);
assert.equal(publicMeta.titleEn, "Create issue");
assert.equal(publicMeta.risk, "control");

console.log("capability observability smoke: PASS");
