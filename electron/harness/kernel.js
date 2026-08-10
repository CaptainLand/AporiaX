import { createHarnessEventBus } from "./event-bus.js";
import { createAgentDefinitionRegistry } from "./agent-definitions.js";
import { HarnessSessionStore } from "./session.js";
import { HarnessScheduler } from "./scheduler.js";
import { HarnessToolHost } from "./tool-host.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import { HarnessPluginHost } from "./plugin-api.js";

export function createHarnessKernel({ onEvent = null, schedulerConcurrency = 4 } = {}) {
  const events = createHarnessEventBus({ onEvent, maxHistory: 2_000 });
  const agents = createAgentDefinitionRegistry();
  const sessions = new HarnessSessionStore({ eventBus: events });
  const scheduler = new HarnessScheduler({ concurrency: schedulerConcurrency, eventBus: events });
  const tools = new HarnessToolHost({ eventBus: events });
  const reviews = new ReviewCoordinator({ eventBus: events });
  const plugins = new HarnessPluginHost({ eventBus: events, agentRegistry: agents, toolHost: tools });

  const kernel = {
    version: 1,
    events,
    agents,
    sessions,
    scheduler,
    tools,
    reviews,
    plugins,
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
        taskRpc: false,
      };
    },
    snapshot() {
      return {
        version: 1,
        capabilities: kernel.capabilities(),
        events: events.snapshot(),
        agents: agents.list(),
        plugins: plugins.list(),
        tools: tools.list().map((tool) => ({ name: tool.name, risk: tool.risk, plugin: tool.plugin || null })),
        sessions: sessions.list(),
        scheduler: scheduler.snapshot(),
      };
    },
  };

  events.emit({ type: "kernel.started", capabilities: kernel.capabilities() });
  return kernel;
}
