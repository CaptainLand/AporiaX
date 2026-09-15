import { verificationDirective } from "./delivery-policy.js";
import { refreshVerification } from "./evidence-ledger.js";

export function snapshotContinuation(selfCheck, changeMap) {
  return {
    version: 1,
    changes: [...changeMap.values()],
    selfCheck: { ...selfCheck, reviewedVersions: [...selfCheck.reviewedVersions],
      segments: (selfCheck.segments || []).map((segment) => ({ ...segment,
        versions: segment.versions instanceof Map ? [...segment.versions] : segment.versions })) },
  };
}

// Saved execution records are historical evidence, NOT proof about a resumed
// environment (dependencies, servers and files outside the change set may differ).
export async function restoreContinuation({ saved, checkpoint, selfCheck, changeMap, latestPrompt, readCurrent }) {
  const stored = saved?.continuation?.selfCheck;
  const priorVerification = stored ? null : checkpoint?.verification;
  if (stored) {
    for (const key of ["started", "required", "requested", "requestReason", "reviewRequested", "focus", "mode",
      "decisionSource", "decisionReason", "verificationRequired", "verificationCandidates", "segmentCounter"])
      if (stored[key] !== undefined) selfCheck[key] = stored[key];
  }
  const directive = verificationDirective(latestPrompt);
  selfCheck.verificationWaived = directive ?? (stored?.verificationWaived ?? priorVerification?.waived ?? false);
  selfCheck.verificationResults = (stored?.verificationResults || priorVerification?.results || []).map((record) => ({
    ...record, stale: true, staleReason: "Task resumed; previous execution is historical, not current-environment verification.",
  }));
  selfCheck.segments = (stored?.segments || []).map((segment) => ({ ...segment, stale: true }));
  selfCheck.recoveryChanges = [...(stored?.recoveryChanges || [])];
  for (const change of saved?.continuation?.changes || []) {
    try {
      const current = await readCurrent(change);
      if (Boolean(current.missing) !== Boolean(change.afterMissing) ||
        (!current.missing && current.content !== change.afterContent)) throw new Error("File changed since the saved run.");
      changeMap.set(change.path, { ...change });
    } catch (error) {
      selfCheck.recoveryChanges.push({ ...change, recoveryError: String(error.message || error) });
    }
  }
  // Never revive a seal, in-flight Review, or a model-written pass claim.
  selfCheck.reviewedVersions = new Map();
  selfCheck.readEvidence = [];
  selfCheck.report = null;
  selfCheck.seal = null;
  selfCheck.completed = false;
  refreshVerification(selfCheck, changeMap);
}
