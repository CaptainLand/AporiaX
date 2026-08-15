import { createHarnessEventBus } from "./event-bus.js";
import { createAgentDefinitionRegistry } from "./agent-definitions.js";
import { HarnessSessionStore } from "./session.js";
import { HarnessScheduler } from "./scheduler.js";
import { HarnessToolHost } from "./tool-host.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import { HarnessPluginHost } from "./plugin-api.js";
import { createSkillRegistry } from "./skills/registry.js";
import { BUNDLED_OFFICE_SKILLS } from "./skills/bundled-office-skills.js";
import { createCapabilityRegistry } from "./capability-registry.js";
import { planAgentBudget } from "./agent-budget.js";
import { BuilderWorkspaceManager } from "./builder-workspace.js";
import { createTaskGraph } from "./task-graph.js";
import {
  createKernelAgentRuntimeBroker,
  setDefaultAgentRuntimeBroker,
} from "./agent-runtime-broker.js";
import { applyRuntimeToolDefinitionOverrides } from "../runtime/tool-definition-overrides.js";

applyRuntimeToolDefinitionOverrides();

export function createHarnessKernel({
  onEvent = null,
  schedulerConcurrency = 4,
  toolDescriptors = [],
  taskRuntime = null,
} = {}) {
  const events = createHarnessEventBus({ onEvent, maxHistory: 2_000 });
  const capabilitiesRegistry = createCapabilityRegistry({ eventBus: events });
  const agents = createAgentDefinitionRegistry();
  if (!agents.has("main")) {
    agents.register({
      name: "main",
      description:
        "Own the user task, coordinate delegated agents, mutate the workspace within policy, and deliver the final verified result.",
      tools: [],
      permissions: {},
      maxRounds: 20,
      background: false,
      triggers: [],
      systemPrompt:
        "Coordinate work through the Harness Kernel and keep delegated work evidence-backed.",
      source: "builtin-kernel",
    });
  }
  const sessions = new HarnessSessionStore({ eventBus: events });
  const scheduler = new HarnessScheduler({
    concurrency: schedulerConcurrency,
    eventBus: events,
  });
  const tools = new HarnessToolHost({
    descriptors: toolDescriptors,
    eventBus: events,
    capabilityRegistry: capabilitiesRegistry,
  });
  const reviews = new ReviewCoordinator({ eventBus: events });
  const plugins = new HarnessPluginHost({
    eventBus: events,
    agentRegistry: agents,
    toolHost: tools,
  });
  const skills = createSkillRegistry({ eventBus: events });
  for (const bundledSkill of BUNDLED_OFFICE_SKILLS) {
    skills.register(bundledSkill, { builtin: true });
  }
  const builders = new BuilderWorkspaceManager({ eventBus: events });
  taskRuntime?.attachEventBus?.(events);

  const kernel = {
    version: 2,
    events,
    agents,
    sessions,
    scheduler,
    tools,
    reviews,
    plugins,
    skills,
    capabilitiesRegistry,
    builders,
    taskRuntime,
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
        capabilityRegistry: true,
        unifiedToolCapabilities: true,
        scopedCapabilities: true,
        reviewVersioning: true,
        plugins: true,
        skills: true,
        skillDiscovery: true,
        projectSkills: true,
        userSkills: true,
        progressiveSkillDisclosure: true,
        browserAutomation: true,
        browserAriaSnapshot: true,
        browserConsoleEvidence: true,
        browserNetworkEvidence: true,
        mcp: true,
        mcpTools: true,
        mcpResources: true,
        mcpPrompts: true,
        mcpStdio: true,
        mcpStreamableHttp: true,
        coreApi: true,
        adaptiveAgentBudget: true,
        taskGraph: true,
        builderIsolation: true,
        builderExecution: true,
        builderScopeLeases: true,
        builderConflictCheckedMerge: true,
        sharedCollaborationContract: true,
        builderPlanApproval: true,
        structuredBuilderHandoff: true,
        boundedCollaborationMailbox: true,
        contractAwareReviewVerify: true,
        collaborationWitnessAudit: true,
        unifiedAgentRuntime: true,
        durableEventStore: true,
        livePeerInterrupts: false,
        taskRpc: Boolean(taskRuntime),
      };
    },
    snapshot() {
      return {
        version: 2,
        capabilities: kernel.capabilities(),
        capabilitySummary: capabilitiesRegistry.summary(),
        capabilityCatalog: capabilitiesRegistry.list().map((capability) => ({
          id: capability.id,
          kind: capability.kind,
          source: capability.source,
          name: capability.name,
          title: capability.title,
          risk: capability.risk,
          scopeId: capability.scopeId,
          plugin: capability.plugin,
          serverId: capability.serverId,
          readOnly: capability.readOnly,
          observable: capability.observable,
          tags: capability.tags,
        })),
        events: events.snapshot(),
        agents: agents.list(),
        plugins: plugins.list(),
        skills: skills.list(),
        tools: tools.list().map((tool) => ({
          name: tool.name,
          risk: tool.risk,
          source:
            tool.source ||
            (tool.plugin
              ? "plugin"
              : tool.name.startsWith("browser_")
                ? "browser"
                : "native"),
          plugin: tool.plugin || null,
        })),
        sessions: sessions.list(),
        scheduler: scheduler.snapshot(),
        builderLeases: builders.leases(),
        tasks: taskRuntime
          ? {
              active: taskRuntime.listActiveRuns?.() || [],
              canStartTasks: Boolean(taskRuntime.canStartTasks?.()),
            }
          : null,
      };
    },
  };

  const agentRuntime = createKernelAgentRuntimeBroker({ kernel });
  kernel.agentRuntime = agentRuntime;
  setDefaultAgentRuntimeBroker(agentRuntime);

  events.emit({
    type: "kernel.started",
    capabilities: kernel.capabilities(),
  });
  return kernel;
}
