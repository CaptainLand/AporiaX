// Workflow choices are not permission grants. Selected commands still pass
// through the regular dispatcher, sandbox and durable-operation boundary.
export function normalizeVerificationSelection(values = []) {
  if (!Array.isArray(values) || values.length > 8) throw new Error("Select at most 8 relevant verification commands.");
  return values.map((value) => {
    const command = String(value?.command || "").trim();
    const cwd = String(value?.cwd || ".").trim().replace(/\\/g, "/");
    const reason = String(value?.reason || "").trim();
    if (!command || command.length > 2000 || !reason || reason.length > 1000) throw new Error("Each selected check needs a command and a concrete relevance reason.");
    if (!cwd || cwd.startsWith("/") || /^[a-z]:/i.test(cwd) || cwd.split("/").includes("..") || cwd.includes("\0")) throw new Error("Verification cwd must stay inside the workspace.");
    return { command, cwd, reason };
  });
}

export function overlayReviewFindings(segments = [], version) {
  const latestByPath = new Map();
  for (const segment of segments || []) {
    if (segment.stale || segment.verificationVersion !== version) continue;
    const reviewed =
      Boolean(segment.reviewAgentId) ||
      (Array.isArray(segment.reviewAgentIds) && segment.reviewAgentIds.length > 0);
    // Command-only segments record verification, but they must not erase Review findings.
    if (!reviewed) continue;
    const findings = (segment.findings || []).filter((finding) =>
      ["critical", "high", "medium"].includes(String(finding.severity || "").toLowerCase()),
    );
    const covered = new Set(
      [...(segment.paths || []), ...findings.map((finding) => finding.path)].filter(Boolean),
    );
    if (!covered.size) continue;
    for (const path of covered) {
      latestByPath.set(
        path,
        findings.filter((finding) => !finding.path || finding.path === path),
      );
    }
  }
  const merged = [];
  const seen = new Set();
  for (const findings of latestByPath.values()) {
    for (const finding of findings) {
      const key = JSON.stringify([finding.severity, finding.path, finding.message]);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(finding);
    }
  }
  return merged;
}

export function assessDelivery(state, changes, version) {
  const latest = new Map();
  for (const item of state.verificationResults || []) {
    if (!item.stale && item.versionSignature === version) latest.set(JSON.stringify([item.command, item.cwd || "."]), item);
  }
  const results = [...latest.values()];
  const failed = results.filter((item) => !item.passed || item.error || item.timedOut);
  const unavailable = failed.length > 0 && failed.every((item) => item.exitCode == null && /ENOENT|command not found|not recognized|sandbox.*(?:unavailable|not ready)|EACCES|permission denied/i.test([item.error, item.output].join(" ")));
  const selected = state.verificationWaived ? [] : state.verificationRequired || [];
  const missing = selected.some((item) => !latest.has(JSON.stringify([item.command, item.cwd || "."])));
  const status = failed.length ? (unavailable ? "unavailable" : "failed") : results.length && !missing ? "passed" : "unverified";
  const findings = overlayReviewFindings(state.segments || [], version);
  const reviewPending = Boolean(state.reviewRequested ?? state.requested) && changes.some((change) => state.reviewedVersions?.get(change.path) !== change.afterContent);
  return { status, passed: status === "passed", attempted: results.length > 0, waived: Boolean(state.verificationWaived), results, findings, reviewPending };
}

export function deliveryNotice(assessment, hasChanges, language = "zh-CN") {
  if (!hasChanges) return "";
  const en = language === "en";
  const messages = {
    unverified: en ? "Verification note: the current version has not had a complete executable check." : "验证说明：当前版本尚未完成运行验证。",
    unavailable: en ? "Verification note: implementation is preserved; the execution environment could not complete the checks." : "验证说明：实现已保存，执行环境未能完成检查。",
    failed: en ? "Verification note: some checks failed; their evidence is retained in the execution records." : "验证说明：部分检查未通过，具体失败记录已保留在执行记录中。",
  };
  const notices = [messages[assessment.status]];
  if (assessment.findings.length) notices.push(en ? "Review findings remain unresolved." : "仍有审查问题未解决。" );
  else if (assessment.reviewPending) notices.push(en ? "Independent review coverage is incomplete." : "独立审查尚未覆盖全部改动。" );
  return notices.filter(Boolean).join(" ");
}

// Routine evidence belongs in the full reply. Consequential failures remain
// visible regardless of how the model chooses to summarize the result.
export function deliveryPresentation(assessment, hasChanges, language = "zh-CN") {
  const details = deliveryNotice(assessment, hasChanges, language);
  if (!hasChanges) return { warning: '', details };
  const en = language === 'en';
  const warnings = [];
  if (assessment.status === 'failed') warnings.push(en
    ? 'Some checks did not pass; the result still needs attention before use.'
    : '还有检查没有通过，使用前需要处理。');
  if (assessment.findings.length) warnings.push(en
    ? 'There are unresolved issues affecting this result.'
    : '还有影响结果的问题尚未解决。');
  return { warning: warnings.join(' '), details };
}
