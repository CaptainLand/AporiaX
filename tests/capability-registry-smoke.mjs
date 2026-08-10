import assert from "node:assert/strict";
import {
  capabilityFromToolDescriptor,
  createCapabilityRegistry,
} from "../electron/harness/capability-registry.js";
import { HarnessToolHost } from "../electron/harness/tool-host.js";
import { createHarnessKernel } from "../electron/harness/kernel.js";

const events = [];
const registry = createCapabilityRegistry({
  eventBus: { emit: (event) => events.push(event) },
});
const readCapability = registry.register({
  kind: "tool",
  source: "native",
  name: "read_file",
  risk: "read",
  title: "Read file",
});
assert.equal(readCapability.readOnly, true);
assert.equal(registry.summary().total, 1);
assert.equal(registry.summary().bySource.native, 1);
assert.equal(registry.find({ kind: "tool", source: "native", name: "read_file" })?.id, readCapability.id);

registry.register({
  kind: "resource",
  source: "mcp",
  name: "docs",
  risk: "read",
  scopeId: "run-1",
  serverId: "demo",
});
registry.register({
  kind: "prompt",
  source: "mcp",
  name: "review",
  risk: "none",
  scopeId: "run-1",
  serverId: "demo",
});
assert.equal(registry.list({ scopeId: "run-1" }).length, 2);
assert.equal(registry.unregisterScope("run-1"), 2);
assert.equal(registry.list({ scopeId: "run-1" }).length, 0);
assert(events.some((event) => event.type === "capability.registered"));
assert(events.some((event) => event.type === "capability.unregistered"));

const toolDescriptor = {
  definition: {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click browser element",
      parameters: { type: "object", properties: {} },
    },
  },
  risk: "control",
};
assert.equal(capabilityFromToolDescriptor(toolDescriptor).source, "browser");

const bridgedRegistry = createCapabilityRegistry();
const host = new HarnessToolHost({ capabilityRegistry: bridgedRegistry });
host.register({
  definition: {
    type: "function",
    function: {
      name: "plugin_tool",
      description: "Plugin tool",
      parameters: { type: "object", properties: {} },
    },
  },
  risk: "write",
  plugin: "example-plugin",
  source: "plugin",
});
assert.equal(bridgedRegistry.list({ source: "plugin" }).length, 1);
host.unregister("plugin_tool");
assert.equal(bridgedRegistry.list({ source: "plugin" }).length, 0);

const kernel = createHarnessKernel({
  toolDescriptors: [
    {
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read",
          parameters: { type: "object", properties: {} },
        },
      },
      risk: "read",
      source: "native",
    },
    toolDescriptor,
  ],
});
assert.equal(kernel.capabilities().capabilityRegistry, true);
assert.equal(kernel.snapshot().capabilitySummary.total, 2);
assert.equal(kernel.snapshot().capabilitySummary.bySource.native, 1);
assert.equal(kernel.snapshot().capabilitySummary.bySource.browser, 1);
assert.equal(kernel.snapshot().capabilityCatalog.length, 2);

console.log("capability registry smoke: PASS");
