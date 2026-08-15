import {
  createHarnessEventBus,
  getDefaultHarnessEventBus,
} from "./harness/event-bus.js";
import {
  agentBudgetAllowsTool,
  currentAgentBudget,
  enforceAgentBudgetEvent,
} from "./harness/agent-budget.js";

const VALID_PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);

const DEFAULT_PERMISSION_POLICIES = {
  "read-only": {
    "*": "deny",
    delegate_subagent: "allow",
    collect_subagents: "allow",
    remember_project_fact: "allow",
    update_plan: "allow",
    list_directory: "allow",
    read_file: "allow",
    read_external_file: "allow",
    search_text: "allow",
    lsp: "allow",
    git_status: "allow",
    git_diff: "allow",
    git_log: "allow",
    git_remote_list: "allow",
    github_pr_view: "allow",
    github_pr_checks: "allow",
    inspect_office_file: "allow",
    browser_open: "allow",
    browser_snapshot: "allow",
    browser_screenshot: "allow",
    browser_console: "allow",
    browser_network: "allow",
    browser_close: "allow",
    request_self_check: "allow",
    complete_self_check: "allow",
  },
  "workspace-write": {
    "*": "deny",
    delegate_subagent: "allow",
    collect_subagents: "allow",
    remember_project_fact: "allow",
    update_plan: "allow",
    list_directory: "allow",
    read_file: "allow",
    read_external_file: "allow",
    search_text: "allow",
    lsp: "allow",
    // Host-level language-server installation may invoke system package managers,
    // so it remains an explicit approval boundary.
    lsp_install: "ask",
    git_status: "allow",
    git_diff: "allow",
    git_log: "allow",
    git_init: "allow",
    git_stage: "allow",
    git_commit: "allow",
    git_create_branch: "allow",
    git_remote_list: "allow",
    // Local/reversible Git plumbing is autonomous. git_push receives an
    // additional effect-policy check before execution, so protected/ambiguous
    // destinations still require approval.
    git_remote_add: "allow",
    git_pull: "allow",
    git_push: "allow",
    github_repo_create: "ask",
    github_pr_create: "allow",
    github_pr_view: "allow",
    github_pr_checks: "allow",
    write_file: "allow",
    apply_patch: "allow",
    create_word_document: "allow",
    create_presentation: "allow",
    create_spreadsheet: "allow",
    inspect_office_file: "allow",
    // Command/process tools are allowed at the policy layer. The runtime effect
    // classifier decides whether each concrete command may auto-run, must ask,
    // or is denied.
    run_command: "allow",
    start_process: "allow",
    read_process: "allow",
    write_stdin: "allow",
    kill_process: "allow",
    // Browser runs in a fresh isolated Playwright context without the user's
    // browser profile/cookies. Ordinary navigation and form interaction are
    // therefore autonomous; high-impact external operations should use native
    // tools with their own effect policy rather than relying on a click prompt.
    browser_open: "allow",
    browser_snapshot: "allow",
    browser_screenshot: "allow",
    browser_console: "allow",
    browser_network: "allow",
    browser_close: "allow",
    browser_click: "allow",
    browser_fill: "allow",
    browser_press: "allow",
    request_self_check: "allow",
    complete_self_check: "allow",
  },
  // Builder workers operate only inside their leased isolated worktree. They
  // may now run verification commands there so a Builder can test its own
  // implementation before handoff. They still cannot delegate more agents or
  // control Browser/MCP/external systems.
  "builder-write": {
    "*": "deny",
    list_directory: "allow",
    read_file: "allow",
    search_text: "allow",
    lsp: "allow",
    git_status: "allow",
    git_diff: "allow",
    git_log: "allow",
    git_remote_list: "allow",
    update_plan: "allow",
    write_file: "allow",
    apply_patch: "allow",
    run_command: "allow",
    request_self_check: "allow",
    complete_self_check: "allow",
  },
};

const ACTION_RESTRICTIVENESS = {
  allow: 0,
  ask: 1,
  deny: 2,
};
const HARNESS_CONTROL_TOOLS = new Set([
  "update_plan",
  "request_self_check",
  "complete_self_check",
]);

function normalizeAction(value, fallback = "deny") {
  return VALID_PERMISSION_ACTIONS.has(value) ? value : fallback;
}

export function createPermissionPolicy(mode, projectOverrides = {}) {
  const base =
    DEFAULT_PERMISSION_POLICIES[mode] ||
    DEFAULT_PERMISSION_POLICIES["read-only"];
  const overrides =
    projectOverrides &&
    typeof projectOverrides === "object" &&
    !Array.isArray(projectOverrides)
      ? projectOverrides
      : {};
  const names = new Set([...Object.keys(base), ...Object.keys(overrides)]);
  const policy = {};

  for (const name of names) {
    const baseAction = normalizeAction(
      base[name],
      normalizeAction(base["*"]),
    );
    if (HARNESS_CONTROL_TOOLS.has(name)) {
      policy[name] = baseAction;
      continue;
    }
    const overrideValue =
      overrides[name] !== undefined ? overrides[name] : overrides["*"];
    const requestedAction = normalizeAction(overrideValue, baseAction);
    // Repository configuration is untrusted input. It may make a task more
    // restrictive, but it must never elevate the permission chosen in the UI.
    policy[name] =
      ACTION_RESTRICTIVENESS[requestedAction] >=
      ACTION_RESTRICTIVENESS[baseAction]
        ? requestedAction
        : baseAction;
  }

  return Object.freeze(policy);
}

export function getToolPermission(policy, toolName) {
  return normalizeAction(
    policy?.[toolName],
    normalizeAction(policy?.["*"]),
  );
}

export class ToolRegistry {
  #tools = new Map();

  constructor(descriptors) {
    for (const descriptor of descriptors || []) {
      const name = descriptor?.definition?.function?.name;
      if (!name || this.#tools.has(name)) {
        throw new Error(`Invalid or duplicate tool definition: ${name}`);
      }
      if (
        !["read", "write", "execute", "control"].includes(
          descriptor.risk,
        )
      ) {
        throw new Error(`Tool ${name} has an invalid risk classification.`);
      }
      this.#tools.set(name, Object.freeze({ ...descriptor, name }));
    }
  }

  get(name) {
    return this.#tools.get(name) || null;
  }

  definitions(policy) {
    return [...this.#tools.values()]
      .filter(
        (descriptor) =>
          getToolPermission(policy, descriptor.name) !== "deny" &&
          agentBudgetAllowsTool(descriptor.name),
      )
      .map((descriptor) => descriptor.definition);
  }

  catalog(policy) {
    return [...this.#tools.values()].map((descriptor) => {
      const budgetAllowed = agentBudgetAllowsTool(descriptor.name);
      return {
        name: descriptor.name,
        risk: descriptor.risk,
        permission: budgetAllowed
          ? getToolPermission(policy, descriptor.name)
          : "deny",
        ...(budgetAllowed ? {} : { budgetBlocked: true }),
      };
    });
  }
}

export function createEventEmitter(onEvent, options = {}) {
  const bus = createHarnessEventBus({
    onEvent,
    now: options.now,
    maxHistory: options.maxHistory ?? 1_000,
  });
  const emit = (event) => {
    if (event?.type === "turn.started") {
      const budget = currentAgentBudget();
      if (budget) event.agentBudget = budget;
    }
    enforceAgentBudgetEvent(event);
    const enriched = bus.emit(event);
    const sharedBus = getDefaultHarnessEventBus();
    if (enriched && sharedBus && sharedBus !== bus) {
      const {
        sequence: runtimeSequence,
        timestamp: runtimeTimestamp,
        ...payload
      } = enriched;
      sharedBus.emit({
        ...payload,
        runtimeSequence,
        runtimeTimestamp,
      });
    }
    return enriched;
  };
  Object.assign(emit, {
    bus,
    on: bus.on.bind(bus),
    once: bus.once.bind(bus),
    hook: bus.hook.bind(bus),
    history: bus.history.bind(bus),
    snapshot: bus.snapshot.bind(bus),
  });
  return emit;
}
