import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createBuilderWorkspaceManager, builderSnapshotLimits } from "../harness/builder-workspace.js";
import { assertSubagentRealScope } from "./subagent-model.js";
import { saveRuntimeContext, executeDurableTool } from "./durable-run.js";

function checkpointBytes(patch, side) {
  if (patch[`${side}Missing`]) return null;
  const encoded = patch[`${side}Base64`] ?? (patch.binary ? patch[`${side}Content`] : null);
  const bytes = encoded == null ? Buffer.from(patch[`${side}Content`] || "", "utf8") : Buffer.from(encoded, "base64");
  if (encoded != null && bytes.toString("base64") !== encoded) throw new Error("Invalid Builder recovery bytes.");
  const expected = patch[`${side}Hash`];
  if (expected && createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Builder recovery checksum mismatch; inspect retained snapshot.");
  return bytes;
}
const sameBytes = (left, right) => left === null || right === null ? left === right : left.equals(right);

export async function runIsolatedBuilder(options, execute) {
  const { agentId, input, session = {}, workspaceRoot, signal } = options;
  session.snapshotLimits ||= builderSnapshotLimits();
  for (const path of input.writeScopes) await assertSubagentRealScope("write_file", { path }, ["."], workspaceRoot);
  const manager = createBuilderWorkspaceManager({ eventBus: { emit: options.emit },
    snapshotLimits: session.snapshotLimits,
    onMergePrepared: async (recovery) => {
      session.mergeRecovery = recovery;
      // Persist the recovery location before the first host file mutation.
      await persist("integrating", null);
    },
  });
  const workspace = await manager.open({ workspaceRoot, agentId, writeScopes: input.writeScopes, signal });
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
      try { current = await readFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const expected = checkpointBytes(patch, "before");
      const desired = checkpointBytes(patch, "after");
      if (current && !patch.beforeHash && !isUtf8(current)) throw new Error("Legacy Builder snapshot cannot safely restore non-UTF-8 content. Inspect retained original worktree.");
      if (sameBytes(current, desired)) continue; // integration may have finished before the crash
      if (!sameBytes(current, expected)) {
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
        session.mergeRecovery = null;
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
    if (error.mergeRecovery) {
      session.mergeRecovery = error.mergeRecovery;
      try { await persist("merge-failed", { status: "failed", summary: error.message, mergeRecovery: error.mergeRecovery }); }
      catch (persistError) { error.message += ` 恢复状态未能写入任务库：${persistError.message}`; }
    }
    options.emit({ type: "subagent.failed", agentId, role: "builder", error: error.message,
      ...(error.mergeRecovery ? { mergeRecovery: error.mergeRecovery } : {}) });
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
