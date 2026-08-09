const VALID_PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);

const DEFAULT_PERMISSION_POLICIES = {
  "read-only": {
    "*": "deny",
    delegate_subagent: "allow",
    collect_subagents: "allow",
    remember_project_fact: "allow",
    list_directory: "allow",
    read_file: "allow",
    search_text: "allow",
    git_status: "allow",
    git_diff: "allow",
    inspect_office_file: "allow",
    complete_self_check: "allow",
  },
  "workspace-write": {
    "*": "deny",
    delegate_subagent: "allow",
    collect_subagents: "allow",
    remember_project_fact: "allow",
    list_directory: "allow",
    read_file: "allow",
    search_text: "allow",
    git_status: "allow",
    git_diff: "allow",
    write_file: "allow",
    apply_patch: "allow",
    create_word_document: "allow",
    create_presentation: "allow",
    create_spreadsheet: "allow",
    inspect_office_file: "allow",
    run_command: "ask",
    complete_self_check: "allow",
  },
};

const ACTION_RESTRICTIVENESS = {
  allow: 0,
  ask: 1,
  deny: 2,
};
const HARNESS_CONTROL_TOOLS = new Set([
  "complete_self_check",
]);

function normalizeAction(value, fallback = "deny") {
  return VALID_PERMISSION_ACTIONS.has(value) ? value : fallback;
}

export function createPermissionPolicy(
  mode,
  projectOverrides = {},
) {
  const base =
    DEFAULT_PERMISSION_POLICIES[mode] ||
    DEFAULT_PERMISSION_POLICIES["read-only"];
  const overrides =
    projectOverrides &&
    typeof projectOverrides === "object" &&
    !Array.isArray(projectOverrides)
      ? projectOverrides
      : {};
  const names = new Set([
    ...Object.keys(base),
    ...Object.keys(overrides),
  ]);
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
      overrides[name] !== undefined
        ? overrides[name]
        : overrides["*"];
    const requestedAction = normalizeAction(
      overrideValue,
      baseAction,
    );
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
          getToolPermission(policy, descriptor.name) !== "deny",
      )
      .map((descriptor) => descriptor.definition);
  }

  catalog(policy) {
    return [...this.#tools.values()].map((descriptor) => ({
      name: descriptor.name,
      risk: descriptor.risk,
      permission: getToolPermission(policy, descriptor.name),
    }));
  }
}

export function createEventEmitter(onEvent) {
  let sequence = 0;
  return (event) => {
    if (!event || typeof event.type !== "string") return;
    sequence += 1;
    onEvent?.({
      sequence,
      timestamp: new Date().toISOString(),
      ...event,
    });
  };
}
