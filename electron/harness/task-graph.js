import { normalizeBuilderScopes } from "./scope-leases.js";

function normalizeTask(input) {
  const id = String(input?.id || "").trim();
  if (!id) throw new Error("Task graph node id is required.");
  const dependencies = [
    ...new Set(
      (input?.dependsOn || input?.depends_on || [])
        .map(String)
        .filter(Boolean),
    ),
  ];
  const role = String(input?.role || "main").trim() || "main";
  const writeScopes =
    role === "builder"
      ? normalizeBuilderScopes(input?.writeScopes || input?.scope || [])
      : [];
  return {
    id,
    title: String(input?.title || id).trim().slice(0, 240),
    task: String(input?.task || input?.instruction || "")
      .trim()
      .slice(0, 4_000),
    role,
    dependencies,
    writeScopes,
    status: "pending",
    agentId: null,
    result: null,
  };
}

function assertAcyclic(nodes) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Task graph contains a cycle at ${id}.`);
    }
    visiting.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Unknown task graph dependency: ${id}`);
    for (const dependency of node.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
}

export class TaskGraph {
  #nodes = new Map();

  constructor(tasks = []) {
    for (const task of tasks) {
      const node = normalizeTask(task);
      if (this.#nodes.has(node.id)) {
        throw new Error(`Duplicate task graph node: ${node.id}`);
      }
      this.#nodes.set(node.id, node);
    }
    for (const node of this.#nodes.values()) {
      for (const dependency of node.dependencies) {
        if (!this.#nodes.has(dependency)) {
          throw new Error(`Unknown dependency ${dependency} for ${node.id}.`);
        }
      }
    }
    assertAcyclic(this.#nodes);
  }

  ready({ role = null } = {}) {
    return [...this.#nodes.values()]
      .filter((node) => node.status === "pending")
      .filter((node) => !role || node.role === role)
      .filter((node) =>
        node.dependencies.every(
          (id) => this.#nodes.get(id)?.status === "completed",
        ),
      )
      .map((node) => this.#public(node));
  }

  claim(id, agentId) {
    const node = this.#require(id);
    if (!this.ready().some((candidate) => candidate.id === node.id)) {
      throw new Error(`Task graph node is not ready: ${node.id}`);
    }
    node.status = "running";
    node.agentId = String(agentId || "").trim() || null;
    return this.#public(node);
  }

  complete(id, result = null) {
    const node = this.#require(id);
    if (node.status !== "running") {
      throw new Error(`Task graph node is not running: ${node.id}`);
    }
    node.status = "completed";
    node.result = result;
    return this.#public(node);
  }

  fail(id, result = null) {
    const node = this.#require(id);
    if (!["running", "pending"].includes(node.status)) {
      throw new Error(
        `Task graph node cannot fail from ${node.status}: ${node.id}`,
      );
    }
    node.status = "failed";
    node.result = result;
    return this.#public(node);
  }

  blocked() {
    return [...this.#nodes.values()]
      .filter((node) => node.status === "pending")
      .filter((node) =>
        node.dependencies.some(
          (id) => this.#nodes.get(id)?.status === "failed",
        ),
      )
      .map((node) => this.#public(node));
  }

  snapshot() {
    return [...this.#nodes.values()].map((node) => this.#public(node));
  }

  #require(id) {
    const node = this.#nodes.get(String(id));
    if (!node) throw new Error(`Unknown task graph node: ${id}`);
    return node;
  }

  #public(node) {
    return {
      id: node.id,
      title: node.title,
      task: node.task,
      role: node.role,
      dependsOn: [...node.dependencies],
      writeScopes: [...node.writeScopes],
      status: node.status,
      agentId: node.agentId,
      result: node.result,
    };
  }
}

export function createTaskGraph(tasks) {
  return new TaskGraph(tasks);
}