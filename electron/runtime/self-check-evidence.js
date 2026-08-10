import { createHash } from "node:crypto";
import { isOfficePath } from "../office-tools.js";

export function buildChanges(changeMap) {
  return [...changeMap.values()].filter(
    (change) =>
      Boolean(change.beforeMissing) !== Boolean(change.afterMissing) ||
      change.beforeContent !== change.afterContent,
  );
}

export function reviewableChanges(changeMap) {
  return buildChanges(changeMap).filter(
    (change) => !change.binary || isOfficePath(change.path),
  );
}

export function createChangeVersionSignature(changes) {
  const digest = createHash("sha256");
  for (const change of [...changes].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update(change.path);
    digest.update("\0");
    digest.update(String(change.afterContent ?? ""));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function getPendingSelfCheckPaths(
  changes,
  reviewedVersions = new Map(),
) {
  const changeList =
    changes instanceof Map
      ? [...changes.values()]
      : Array.isArray(changes)
        ? changes
        : [];
  return changeList
    .filter(
      (change) =>
        !change?.afterMissing &&
        (!change?.binary || isOfficePath(change.path)) &&
        (Boolean(change?.beforeMissing) !== Boolean(change?.afterMissing) ||
          change?.beforeContent !== change?.afterContent) &&
        reviewedVersions.get(change.path) !== change.afterContent,
    )
    .map((change) => change.path);
}

function normalizeSelfCheckList(value, fieldName) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${fieldName} must be an array with at most 20 items.`);
  }
  return value.map((item) => {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > 1_000
    ) {
      throw new Error(
        `${fieldName} items must be non-empty strings under 1000 characters.`,
      );
    }
    return item.trim();
  });
}

export function normalizeSelfCheckReport(input) {
  if (
    typeof input?.summary !== "string" ||
    !input.summary.trim() ||
    input.summary.trim().length > 4_000
  ) {
    throw new Error(
      "Self-check summary must be between 1 and 4000 characters.",
    );
  }
  const checks = normalizeSelfCheckList(input.checks, "checks");
  if (checks.length === 0) {
    throw new Error("Self-check must include at least one concrete check.");
  }
  return {
    summary: input.summary.trim(),
    checks,
    improvements: normalizeSelfCheckList(input.improvements, "improvements"),
    remainingRisks: normalizeSelfCheckList(
      input.remaining_risks,
      "remaining_risks",
    ),
  };
}

export function parseProgressiveReviewReport(summary, kind) {
  const source = String(summary || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate =
    fenced ||
    source.slice(
      Math.max(0, source.indexOf("{")),
      source.lastIndexOf("}") + 1,
    );
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      verdict: "uncertain",
      checks: [],
      findings: [],
      commands: [],
      remainingRisks: ["子 Agent 未返回可解析的结构化自检报告。"],
      parseError: true,
    };
  }
  const allowedVerdicts =
    kind === "verify"
      ? new Set(["pass", "fail", "not_run", "uncertain"])
      : new Set(["pass", "needs_changes", "uncertain"]);
  const verdict = allowedVerdicts.has(parsed?.verdict)
    ? parsed.verdict
    : "uncertain";
  return {
    verdict,
    checks: Array.isArray(parsed?.checks)
      ? parsed.checks.map(String).filter(Boolean).slice(0, 20)
      : [],
    findings: Array.isArray(parsed?.findings)
      ? parsed.findings
          .map((finding) => ({
            severity: String(finding?.severity || "medium").toLowerCase(),
            path: String(finding?.path || ""),
            message: String(finding?.message || "").trim(),
          }))
          .filter((finding) => finding.message)
          .slice(0, 20)
      : [],
    commands: Array.isArray(parsed?.commands)
      ? parsed.commands
          .map((command) => ({
            command: String(command?.command || ""),
            cwd: String(command?.cwd || "."),
            exitCode: Number.isInteger(command?.exit_code)
              ? command.exit_code
              : null,
            passed: command?.passed === true,
          }))
          .filter((command) => command.command)
          .slice(0, 8)
      : [],
    remainingRisks: Array.isArray(parsed?.remaining_risks)
      ? parsed.remaining_risks.map(String).filter(Boolean).slice(0, 20)
      : [],
    parseError: verdict === "uncertain",
  };
}

export function createProgressiveReviewTask(changes, reason, language) {
  const fileList = changes
    .map(
      (change) =>
        `- ${change.path}${change.afterMissing ? " (deleted)" : ""}`,
    )
    .join("\n");
  const outputSchema = [
    "Return only one JSON object with this exact shape:",
    '{"verdict":"pass|needs_changes|uncertain","checks":["..."],"findings":[{"severity":"critical|high|medium|low","path":"...","message":"..."}],"remaining_risks":["..."]}',
  ].join("\n");
  if (language === "en") {
    return [
      `Perform an automated staged review (${reason}).`,
      "Read every delegated file after its latest write. Use inspect_office_file for Office artifacts.",
      "For a deleted path, confirm the deletion with read_file and inspect git_diff when available.",
      "Review correctness, completeness, security, regressions, maintainability, and obvious edge cases.",
      "Do not edit files. A pass verdict means there are no unresolved critical, high, or medium findings.",
      fileList,
      outputSchema,
    ].join("\n");
  }
  return [
    `执行自动分段自检（${reason}）。`,
    "逐一读取下列文件的最新版本；Office 文件必须使用 inspect_office_file。",
    "对于已删除路径，使用 read_file 确认其不存在，并在可用时检查 git_diff。",
    "检查正确性、完整性、安全性、回归风险、可维护性和明显边界条件。",
    "禁止修改文件。只有不存在尚未解决的严重、高级或中级问题时才能返回 pass。",
    fileList,
    outputSchema,
  ].join("\n");
}

export function createProgressiveVerifyTask(candidates, reason, language) {
  const candidateList = candidates
    .map((candidate) => `- ${candidate.command} (cwd: ${candidate.cwd})`)
    .join("\n");
  const outputSchema = [
    "Return only one JSON object with this exact shape:",
    '{"verdict":"pass|fail|not_run|uncertain","commands":[{"command":"...","cwd":".","exit_code":0,"passed":true}],"checks":["..."],"remaining_risks":["..."]}',
  ].join("\n");
  if (language === "en") {
    return [
      `Perform staged verification (${reason}).`,
      "Run the single most relevant command below. Do not edit source files. Report the exact observed exit code.",
      candidateList,
      outputSchema,
    ].join("\n");
  }
  return [
    `执行分段验证（${reason}）。`,
    "从下列候选中运行一条最相关的命令。禁止修改源文件，并如实记录命令和退出码。",
    candidateList,
    outputSchema,
  ].join("\n");
}

export function buildSelfCheckResult(selfCheck, changeMap) {
  const changedPaths = buildChanges(changeMap).map((change) => change.path);
  if (changedPaths.length === 0) {
    return {
      required: false,
      completed: true,
      reviewedFiles: [],
      summary: "",
      checks: [],
      improvements: [],
      remainingRisks: [],
      verification: {
        required: false,
        attempted: false,
        passed: false,
        candidates: [],
        results: [],
      },
      mode: selfCheck.mode || "progressive",
      segments: [],
      seal: selfCheck.seal || null,
    };
  }
  return {
    required: true,
    completed: Boolean(selfCheck.completed),
    reviewedFiles: changedPaths.filter(
      (path) =>
        selfCheck.reviewedVersions.get(path) === changeMap.get(path)?.afterContent,
    ),
    summary: selfCheck.report?.summary || "",
    checks: selfCheck.report?.checks || [],
    improvements: selfCheck.report?.improvements || [],
    remainingRisks: selfCheck.report?.remainingRisks || [],
    mode: selfCheck.mode || "legacy",
    segments: (selfCheck.segments || []).map((segment) => ({
      id: segment.id,
      reason: segment.reason,
      planStepId: segment.planStepId || null,
      paths: segment.paths,
      status: segment.status,
      verdict: segment.verdict,
      startedAt: segment.startedAt,
      completedAt: segment.completedAt || null,
      reviewAgentId: segment.reviewAgentId || null,
      reviewAgentIds: segment.reviewAgentIds || [],
      verifyAgentId: segment.verifyAgentId || null,
      findings: segment.findings || [],
      checks: segment.checks || [],
      remainingRisks: segment.remainingRisks || [],
    })),
    seal: selfCheck.seal || null,
    verification: {
      required: selfCheck.verificationCandidates.length > 0,
      attempted: selfCheck.verificationAttempted,
      passed: selfCheck.verificationPassed,
      candidates: selfCheck.verificationCandidates,
      results: selfCheck.verificationResults,
    },
  };
}

export function createSelfCheckPrompt(
  changeMap,
  verificationCandidates,
  language = "zh-CN",
) {
  const changes = buildChanges(changeMap);
  const reviewable = changes.filter(
    (change) =>
      !change.afterMissing && (!change.binary || isOfficePath(change.path)),
  );
  const changedPaths = reviewable.map((change) => change.path);
  const includesOfficeArtifacts = changes.some(
    (change) =>
      !change.afterMissing && change.binary && isOfficePath(change.path),
  );
  if (language === "en") {
    return [
      "Begin the mandatory self-check phase. A final answer will not be accepted yet.",
      "Use read_file to re-read every file changed in this turn, then check correctness, completeness, security, performance, and obvious edge cases:",
      ...changedPaths.map((path) => `- ${path}`),
      includesOfficeArtifacts
        ? "For every changed .docx, .pptx, or .xlsx file, use inspect_office_file instead of read_file. Confirm that the package is valid and that its document blocks, slides, sheets, rows, and formulas match the request. If an Office artifact is wrong, regenerate it with its create_* tool rather than write_file. Structural inspection does not prove the final visual layout, so record the missing visual render check in remaining_risks."
        : "",
      "Fix problems immediately with write_file or apply_patch. Re-read every file after its latest write.",
      verificationCandidates.length
        ? [
            "Harness found the following project verification commands. Use run_command to attempt at least one relevant check; Harness will apply the current sandbox and approval policy:",
            ...verificationCandidates.map(
              (candidate) =>
                `- ${candidate.command} (directory: ${candidate.cwd})`,
            ),
          ].join("\n")
        : "No test, typecheck, lint, or build script was found in package.json. Perform a static review and record the missing runtime verification as a remaining risk.",
      "After all checks, call complete_self_check with concrete checks, improvements, and remaining risks. Do not provide the final answer before calling it.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "进入强制自检阶段。最终答复暂时不会被接受。",
    "你必须使用 read_file 重新读取下面每个本轮修改过的文件，并检查正确性、完整性、安全性、性能和明显的边界情况：",
    ...changedPaths.map((path) => `- ${path}`),
    includesOfficeArtifacts
      ? "For every changed .docx, .pptx, or .xlsx file, use inspect_office_file instead of read_file. Confirm that the package is valid and that its document blocks, slides, sheets, rows, and formulas match the request. If an Office artifact is wrong, regenerate it with its create_* tool rather than write_file. Structural inspection does not prove the final visual layout, so record the missing visual render check in remaining_risks."
      : "",
    "发现问题时立即使用 write_file 修复。任何再次写入的文件都必须在修复后重新 read_file。",
    verificationCandidates.length
      ? [
          "Harness 检测到以下项目验证命令。必须使用 run_command 至少尝试一项最相关的验证；Harness 会按当前沙箱与审批策略执行：",
          ...verificationCandidates.map(
            (candidate) =>
              `- ${candidate.command}（目录：${candidate.cwd}）`,
          ),
        ].join("\n")
      : "未自动发现 package.json 中的 test/typecheck/lint/build 脚本；请进行静态复核并把未运行验证记录为剩余风险。",
    "全部复核完成后，调用 complete_self_check 提交具体检查项、改进内容和剩余风险。不要在调用该工具前给出最终答复。",
  ].join("\n");
}

export function findVerificationCandidate(candidates, input) {
  if (!input || !Array.isArray(candidates)) return null;
  const command = String(input.command || "").trim();
  const cwd = String(input.cwd || ".")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "") || ".";
  return (
    candidates.find(
      (candidate) =>
        candidate.command === command && candidate.cwd === cwd,
    ) || null
  );
}
