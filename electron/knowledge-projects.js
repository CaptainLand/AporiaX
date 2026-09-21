import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createProjectUnderstandingStore, projectDigest, serializeStore, normalizeProjectUnderstandingCandidate } from "./project-understanding.js";

const LEGACY = Object.freeze({ id: "legacy", name: "未分类（旧知识）", description: "原工作区知识，未自动分配给新项目。", directory: "", legacy: true });
const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const validId = (value) => value === "legacy" || /^kp-[a-f0-9]{24}$/.test(value);

export async function createKnowledgeWorkspace({ baseDirectory, workspaceRoot }) {
  if (!baseDirectory || !workspaceRoot) throw new Error("Knowledge requires a persistent workspace.");
  const indexPath = join(baseDirectory, `${projectDigest(workspaceRoot)}.projects.json`);
  async function readIndex() {
    try {
      const value = JSON.parse(await readFile(indexPath, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.some((p) => !validId(p.id) || p.id === "legacy")) throw new Error("Invalid knowledge project index; original data was not changed.");
      return value;
    } catch (error) { if (error.code === "ENOENT") return { version: 1, projects: [] }; throw error; }
  }
  const list = async () => [LEGACY, ...(await readIndex()).projects];
  async function open(id) {
    if (!validId(id) || !(await list()).some((project) => project.id === id)) throw new Error("Knowledge project is not in this workspace.");
    return createProjectUnderstandingStore({ baseDirectory, workspaceRoot, knowledgeProjectId: id });
  }
  async function create({ name, description = "", directory = "", taskId = "" }) {
    name = clean(name, 80); description = clean(description, 400);
    if (!name || name === LEGACY.name) throw new Error("Choose a non-empty, distinct project name.");
    directory = String(directory || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (directory.length > 300 || directory.includes("\0") || directory.startsWith("/") || directory.includes(":") || directory.split("/").includes("..")) throw new Error("Project directory must be workspace-relative.");
    // Reuse the existing secret filter; metadata reaches model tool results too.
    normalizeProjectUnderstandingCandidate({ content: `${name} ${description} ${directory}` });
    return serializeStore(indexPath, async () => {
      const index = await readIndex();
      const normalized = name.normalize("NFKC").toLocaleLowerCase();
      const existing = index.projects.find((p) => p.name.normalize("NFKC").toLocaleLowerCase() === normalized);
      if (existing) return { project: existing, created: false };
      if (index.projects.length >= 100) throw new Error("This workspace already has 100 knowledge projects.");
      const id = `kp-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
      const project = { id, name, description, directory, createdAt: new Date().toISOString(), createdByTask: clean(taskId, 160) };
      index.projects.push(project);
      const temporary = `${indexPath}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(index, null, 2), "utf8"); await rename(temporary, indexPath); }
      finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
      return { project, created: true };
    });
  }
  return { list, open, create };
}

// A run locks to one logical project. UI browsing and other runs cannot change it.
export async function createKnowledgeSession({ baseDirectory, workspaceRoot, enabled = false, projectId = "", canWrite = false, taskId = "", runId = "", emit = () => {} }) {
  const available = Boolean(enabled && baseDirectory && workspaceRoot);
  const workspace = available ? await createKnowledgeWorkspace({ baseDirectory, workspaceRoot }) : null;
  let selectedId = available ? String(projectId || "") : "";
  let store = selectedId ? await workspace.open(selectedId) : await createProjectUnderstandingStore({});
  const select = async (id) => {
    if (selectedId && selectedId !== id) throw new Error("This run is bound to another knowledge project. Change the task selection before the next run.");
    store = await workspace.open(id); selectedId = id;
    emit({ type: "knowledge.project.selected", knowledgeProjectId: id, workspaceRoot });
  };
  // Serialize selection/save to prevent parallel tool calls from crossing project boundaries.
  let pending = Promise.resolve();
  async function execute(input = {}) {
    if (!available) throw new Error("Project knowledge is disabled for this task.");
    const action = input.action;
    if (action === "list") return { projects: await workspace.list(), selectedProjectId: selectedId || null };
    if (action === "create") {
      if (!canWrite) throw new Error("Creating knowledge projects requires workspace-write permission.");
      if (selectedId) throw new Error("This run already has a knowledge project. Reuse it; create another project from the knowledge panel.");
      const result = await workspace.create({ ...input, taskId });
      await select(result.project.id);
      return result;
    }
    if (input.project_id) await select(String(input.project_id));
    if (!selectedId) throw new Error("List projects and select a matching project, or create one, before reading or saving knowledge.");
    if (action === "select") return { selectedProjectId: selectedId };
    if (action === "search" || action === "read") {
      if (action === "search" && !String(input.query || "").trim()) throw new Error("Search requires a query.");
      if (action === "read" && (!Array.isArray(input.fact_ids) || !input.fact_ids.length)) throw new Error("Read requires fact_ids from search results.");
      const result = await store.readKnowledge({ query: clean(input.query, 1000), factIds: action === "read" ? input.fact_ids.slice(0, 8) : [], limit: input.limit });
      emit({ type: "knowledge.read", knowledgeProjectId: selectedId, workspaceRoot, query: clean(input.query, 200), factIds: result.facts.map((f) => f.id), count: result.facts.length });
      return { projectId: selectedId, ...result };
    }
    if (action === "save") {
      if (!canWrite) throw new Error("Saving knowledge requires workspace-write permission.");
      const fact = normalizeProjectUnderstandingCandidate(input);
      if (!fact.evidence.length) throw new Error("Knowledge requires evidence. Supply a source file or an explicit user decision.");
      const result = await store.commit({ taskId, runId, source: "agent-explicit-save", summary: "Agent saved project knowledge with evidence", changes: [{ ...fact, operation: "upsert" }] });
      emit({ type: "understanding.updated", knowledgeProjectId: selectedId, revision: result.state.currentRevision, summary: result.revision?.summary, factCount: result.state.facts.length });
      return { committed: result.committed, projectId: selectedId, revision: result.state.currentRevision };
    }
    throw new Error("Unknown project knowledge action.");
  }
  return { enabled: available, get projectId() { return selectedId; }, get store() { return store; }, call(input) { const result = pending.catch(() => {}).then(() => execute(input)); pending = result; return result; } };
}
