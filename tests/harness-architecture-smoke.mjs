import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarnessEventBus } from "../electron/harness/event-bus.js";
import { createAgentDefinitionRegistry, loadWorkspaceAgentDefinitions } from "../electron/harness/agent-definitions.js";
import { HarnessSessionStore } from "../electron/harness/session.js";
import { HarnessScheduler } from "../electron/harness/scheduler.js";
import { ReviewCoordinator } from "../electron/harness/review-coordinator.js";
import { HarnessPluginHost } from "../electron/harness/plugin-api.js";
import { createHarnessKernel } from "../electron/harness/kernel.js";
import { createHarnessCoreServer } from "../electron/harness/core-server.js";
import { createHarnessCoreClient } from "../electron/harness/core-client.js";

const emitted = [];
const bus = createHarnessEventBus({ onEvent: (event) => emitted.push(event) });
let wildcard = 0;
let hookOrder = [];
bus.on("tool.*", () => { wildcard += 1; });
bus.hook("tool.started", () => hookOrder.push("low"), { priority: 1 });
bus.hook("tool.started", () => hookOrder.push("high"), { priority: 10 });
const first = bus.emit({ type: "tool.started", tool: "read_file" });
assert.equal(first.sequence, 1);
assert.equal(wildcard, 1);
assert.deepEqual(hookOrder, ["high", "low"]);
assert.equal(bus.history({ type: "tool.*" }).length, 1);

const registry = createAgentDefinitionRegistry();
assert(registry.get("review"));
const workspace = await mkdtemp(join(tmpdir(), "aporiax-agent-def-"));
await mkdir(join(workspace, ".aporiax", "agents"), { recursive: true });
await writeFile(
  join(workspace, ".aporiax", "agents", "security-review.md"),
  `---\nname: security-review\nextends: review\ntools: ["read_file","search_text"]\nmaxRounds: 5\nbackground: true\ntriggers: ["changes.batch.ready"]\n---\nFocus on authentication, authorization, secret handling, and injection risks.\n`,
  "utf8",
);
await loadWorkspaceAgentDefinitions(workspace, { registry });
const securityReview = registry.get("security-review");
assert.equal(securityReview.extends, "review");
assert.deepEqual(securityReview.tools, ["read_file", "search_text"]);
assert.equal(securityReview.maxRounds, 5);
assert.match(securityReview.systemPrompt, /authentication/);

const sessionStore = new HarnessSessionStore({ eventBus: bus });
const session = sessionStore.create({ id: "session-1", task: "smoke" });
sessionStore.transition(session.id, "running");
sessionStore.transition(session.id, "completed", { result: { ok: true } });
assert.equal(sessionStore.get(session.id).state, "completed");

const scheduler = new HarnessScheduler({ concurrency: 2, eventBus: bus });
const order = [];
const a = scheduler.enqueue({ id: "a", priority: 1, run: async () => { order.push("a"); return "A"; } });
const b = scheduler.enqueue({ id: "b", priority: 2, run: async () => { order.push("b"); return "B"; } });
assert.equal(await a.promise, "A");
assert.equal(await b.promise, "B");
assert.equal(order.length, 2);

const reviews = new ReviewCoordinator({ eventBus: bus });
reviews.update("a.js", "v1");
const batch = reviews.createBatch(["a.js"]);
assert.equal(reviews.isCurrent(batch), true);
reviews.update("a.js", "v2");
assert.equal(reviews.isCurrent(batch), false);
assert.equal(reviews.accept(batch, { verdict: "pass" }), null);

const pluginHost = new HarnessPluginHost({ eventBus: bus, agentRegistry: registry });
pluginHost.register({
  name: "smoke-plugin",
  version: "1.0.0",
  setup(api) {
    api.agents.register({
      name: "docs-review",
      extends: "review",
      description: "Review docs",
      tools: ["read_file"],
      systemPrompt: "Review documentation only.",
    });
    api.tools.register({ name: "plugin_echo", risk: "read" });
  },
});
assert(pluginHost.get("smoke-plugin"));
assert(registry.get("docs-review"));
assert.equal(pluginHost.tools()[0].name, "plugin_echo");

const kernel = createHarnessKernel();
assert.equal(kernel.capabilities().skills, true);
assert.equal(kernel.capabilities().progressiveSkillDisclosure, true);
assert.deepEqual(kernel.skills.list(), []);
const core = createHarnessCoreServer({ kernel });
await core.listen();
const client = createHarnessCoreClient({ baseUrl: core.url, token: core.token });
const health = await client.health();
assert.equal(health.ok, true);
assert.equal(health.capabilities.eventBus, true);
assert.equal(health.capabilities.skills, true);
assert.equal(health.capabilities.taskRpc, false);
const agents = await client.agents();
assert(agents.agents.some((agent) => agent.name === "review"));
const skills = await client.skills();
assert.deepEqual(skills.skills, []);
await core.close();
await rm(workspace, { recursive: true, force: true });

console.log("harness architecture smoke: PASS");
