import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createBuilderWorkspaceManager } from "../harness/builder-workspace.js";
import { assertSubagentRealScope } from "./subagent-model.js";
import { saveRuntimeContext, executeDurableTool } from "./durable-run.js";

export async function runIsolatedBuilder(options, execute) {
  const { agentId, input, session = {}, workspaceRoot, signal } = options;
  for (const path of input.writeScopes) await assertSubagentRealScope("write_file", { path }, ["."], workspaceRoot);
  const manager = createBuilderWorkspaceManager({ eventBus: { emit: options.emit } });
  const workspace = await manager.open({ workspaceRoot, agentId, writeScopes: input.writeScopes });
  if (session.activeWorktree) (session.recoveryWorktrees ||= []).push(session.activeWorktree);
  session.activeWorktree = workspace.workspaceRoot;
  let mayClose = false;
  let terminalEvent = null;
  const persist = (status, result) => saveRuntimeContext(agentId, {
    kind: "worker", workspaceRoot, input, session, status, result,
  });
  try {
    // Reconstitute unfinished edits, but only against the same base version.
    // A parent edit since interruption is a conflict, not permission to overwrite.
    const restore = [];
    for (const patch of session.provisionalChanges || []) {
      await assertSubagentRealScope("write_file", { path: patch.path }, input.writeScopes, workspace.workspaceRoot);
      const path = resolve(workspace.workspaceRoot, patch.path);
      let current = null;
      try { current = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const expected = patch.beforeMissing ? null : patch.beforeContent;
      const desired = patch.afterMissing ? null : patch.afterContent;
      if (current === desired) continue; // integration may have finished before the crash
      if (current !== expected) {
        const result = { agentId, role: "builder", status: "blocked", summary: `Builder recovery conflict: ${patch.path}. Saved provisional edits were retained; parent file was not overwritten.`, evidence: [], provisionalChanges: session.provisionalChanges.map(({ path }) => ({ path })) };
        session.activeWorktree = null;
        await persist("blocked", result); mayClose = true; return result;
      }
      restore.push({ path, desired });
    }
    for (const { path, desired } of restore) {
      if (desired === null) await rm(path, { force: true });
      else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, desired); }
    }
    let result;
    try {
      result = await execute({ ...options, __builderIsolated: true,
        workspaceRoot: workspace.workspaceRoot, ownerWorkspaceRoot: workspaceRoot,
        snapshotProvisional: async () => { session.provisionalChanges = await workspace.snapshot(); },
        emit: (event) => {
          if (["subagent.completed", "subagent.failed", "subagent.cancelled"].includes(event.type)) terminalEvent = event;
          else options.emit(event);
        } });
    } catch (error) {
      result = { agentId, role: "builder", status: signal?.aborted || error.name === "AbortError" ? "interrupted" : "failed",
        summary: error.message, evidence: error.evidence || [], steps: error.steps || [], usage: error.usage || null };
    }
    session.provisionalChanges = await workspace.snapshot();
    // Persist edits before either integration or removal of the temporary worktree.
    await persist("integrating", result);
    if (result.status === "completed" && !signal?.aborted) {
      const merged = await executeDurableTool("builder_merge", { agentId, writeScopes: input.writeScopes },
        () => workspace.merge(), options.requestApproval);
      if (merged.merged) {
        session.provisionalChanges = [];
        result = { ...result, changes: merged.changes, integrated: true };
        await options.onBuilderMerge?.(merged);
      } else {
        result = { ...result, status: "blocked", integrated: false, conflicts: merged.conflicts,
          summary: `Builder changes were saved but NOT integrated: ${merged.conflicts.join(", ")}. Resolve the conflicts before relying on this work.` };
      }
    } else {
      result = { ...result, integrated: false };
    }
    session.activeWorktree = null;
    await persist(result.status, result);
    mayClose = true;
    options.emit({ ...(terminalEvent || {}), type: result.status === "interrupted" ? "subagent.cancelled" : "subagent.completed",
      agentId, role: "builder", status: result.status, summary: result.summary, integrated: result.integrated });
    return result;
  } catch (error) {
    options.emit({ type: "subagent.failed", agentId, role: "builder", error: error.message });
    throw error;
  } finally {
    if (mayClose) await workspace.close();
    else {
      // A failed durable write must not destroy the only copy of completed work.
      options.emit({ type: "builder.workspace.retained", agentId, path: workspace.workspaceRoot,
        reason: "Snapshot or persistence failed; worktree retained for manual recovery." });
    }
  }
}
