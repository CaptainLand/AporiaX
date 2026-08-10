import { createHarnessEventBus } from "./event-bus.js";
import { createAgentDefinitionRegistry } from "./agent-definitions.js";
import { HarnessSessionStore } from "./session.js";
import { HarnessScheduler } from "./scheduler.js";
import { HarnessToolHost } from "./tool-host.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import { HarnessPluginHost } from "./plugin-api.js";
import { planAgentBudget } from "./agent-budget.js";
import { BuilderWorkspaceManager } from "./builder-workspace.js";
import { createTaskGraph } from "./task-graph.js";

export function createHarnessKernel({
  onEvent = null,
  schedulerConcurrency = 4,
} = {}) {
  const events = createHarnessEventBus({ onEvent, maxHistory: 2_000 });
  const agents = createAgentDefinitionRegistry();
  agents.register({
    name: "builder",
    description:
      "Implement a delegated change inside an isolated workspace and an explicit non-overlapping write scope.",
    tools: [
      "list_directory",
      "read_file",
      "search_text",
      "git_diff",
      "write_file",
      "apply_patch",
    ],
    permissions: {
      "*": "deny",
      write_file: "allow",
      apply_patch: "allow",
    },
    maxRounds: 8,
    background: true,
    triggers: ["task.builder.ready"],
    systemPrompt:
      "Modify only the delegated write scope. Never broaden the scope, run arbitrary commands, or edit files owned by another Builder.",
    source: "builtin:v2",
  });
  const sessions = new HarnessSessionStore({ eventBus: events });
  const scheduler = new HarnessScheduler({
    concurrency: schedulerConcurrency,
    eventBus: events,
  });
  const tools = new HarnessToolHost({ eventBus: events });
  const reviews = new ReviewCoordinator({ eventBus: events });
  const plugins = new HarnessPluginHost({
    eventBus: events,
    agentRegistry: agents,
    toolHost: tools,
  });
  const builders = new BuilderWorkspaceManager({ eventBus: events });

  const kernel = {
    version: 2,
    events,
    agents,
    sessions,
    scheduler,
    tools,
    reviews,
    plugins,
    builders,
    planAgentBudget,
    createTaskGraph,
    capabilities() {
      return {
        eventBus: true,
        hooks: true,
        declarativeAgents: true,
        scheduler: true,
        contextController: true,
        toolHost: true,
        reviewVersioning: true,
        plugins: true,
        coreApi: true,
        adaptiveAgentBudget: true,
        taskGraph: true,
        builderIsolation: true,
        builderExecution: false,
        taskRpc: false,
      };
    },
    snapshot() {
      return {
        version: 2,
        capabilities: kernel.capabilities(),
        events: events.snapshot(),
        agents: agents.list(),
        plugins: plugins.list(),
        tools: tools.list().map((tool) => ({
          name: tool.name,
          risk: tool.risk,
          plugin: tool.plugin || null,
        })),
        sessions: sessions.list(),
        scheduler: scheduler.snapshot(),
        builderLeases: builders.leases(),
      };
    },
  };

  events.emit({
    type: "kernel.started",
    capabilities: kernel.capabilities(),
  });
  return kernel;
}