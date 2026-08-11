import { isOfficePath } from "../office-tools.js";
import {
  buildChanges,
  buildSelfCheckResult,
  createChangeVersionSignature,
  createProgressiveReviewTask,
  createProgressiveVerifyTask,
  findVerificationCandidate,
  parseProgressiveReviewReport,
  reviewableChanges,
} from "./self-check-evidence.js";

function isConfirmedMissingFileEvidence(item) {
  if (item?.tool !== "read_file" || !item?.error) return false;
  return /\bENOENT\b|not found|does not exist|cannot find|不存在|找不到/i.test(
    String(item.error),
  );
}

function reviewEvidenceCoversChange(change, item) {
  if (item?.path !== change.path) return false;
  if (change.afterMissing) {
    return (
      (item.tool === "git_diff" && !item.error) ||
      isConfirmedMissingFileEvidence(item)
    );
  }
  if (item?.error) return false;
  return change.binary
    ? item.tool === "inspect_office_file"
    : item.tool === "read_file";
}

export function createSelfCheckCoordinator({
  selfCheck,
  changeMap,
  language = "zh-CN",
  emit = () => {},
  startSubagent,
  commandToolAvailable = false,
  discoverVerificationCommands,
  workspaceRoot,
} = {}) {
  if (!selfCheck || !(changeMap instanceof Map)) {
    throw new Error("Self-check coordinator requires selfCheck state and changeMap.");
  }
  if (typeof startSubagent !== "function") {
    throw new Error("Self-check coordinator requires startSubagent.");
  }
  if (typeof discoverVerificationCommands !== "function") {
    throw new Error("Self-check coordinator requires verification discovery.");
  }

  let progressiveReviewJob = null;

  const currentPendingChanges = () =>
    reviewableChanges(changeMap).filter(
      (change) =>
        selfCheck.reviewedVersions.get(change.path) !== change.afterContent,
    );

  const runSegment = async ({
    reason,
    planStepId = null,
    runVerification = false,
  }) => {
    const pendingChanges = currentPendingChanges();
    if (
      runVerification &&
      commandToolAvailable &&
      selfCheck.verificationCandidates.length === 0
    ) {
      selfCheck.verificationCandidates =
        await discoverVerificationCommands(workspaceRoot, changeMap);
    }
    const verificationCandidates = runVerification
      ? selfCheck.verificationCandidates.slice(0, 4)
      : [];
    if (!pendingChanges.length && !verificationCandidates.length) return null;

    selfCheck.segmentCounter += 1;
    const segmentId = `segment-${selfCheck.segmentCounter}`;
    const versions = new Map(
      pendingChanges.map((change) => [change.path, change.afterContent]),
    );
    const segment = {
      id: segmentId,
      reason,
      planStepId,
      paths: pendingChanges.map((change) => change.path),
      versions,
      versionSignature: createChangeVersionSignature(pendingChanges),
      status: "running",
      verdict: "uncertain",
      startedAt: new Date().toISOString(),
      completedAt: null,
      reviewAgentId: null,
      reviewAgentIds: [],
      verifyAgentId: null,
      findings: [],
      checks: [],
      remainingRisks: [],
    };
    selfCheck.segments.push(segment);
    emit({
      type: "self_check.segment.started",
      segmentId,
      reason,
      planStepId,
      paths: segment.paths,
      verificationCandidates,
    });

    const reviewGroupCount = Math.min(
      verificationCandidates.length ? 1 : 2,
      pendingChanges.length,
    );
    const reviewGroups = Array.from({ length: reviewGroupCount }, () => []);
    pendingChanges.forEach((change, index) => {
      reviewGroups[index % reviewGroupCount]?.push(change);
    });
    const reviewPromises = reviewGroups.map((changes, index) =>
      startSubagent(
        {
          role: "review",
          task: createProgressiveReviewTask(changes, reason, language),
          scope:
            changes.length <= 12
              ? changes.map((change) => change.path)
              : ["."],
          background: false,
          max_rounds: Math.min(
            6,
            Math.max(3, Math.ceil(changes.length / 6) + 2),
          ),
        },
        `${segmentId}-review-${index + 1}`,
      ),
    );
    const verifyPromise = verificationCandidates.length
      ? startSubagent(
          {
            role: "verify",
            task: createProgressiveVerifyTask(
              verificationCandidates,
              reason,
              language,
            ),
            scope: ["."],
            background: false,
            max_rounds: 4,
          },
          `${segmentId}-verify`,
        )
      : Promise.resolve(null);
    const [reviewResults, verifyResult] = await Promise.all([
      Promise.all(reviewPromises),
      verifyPromise,
    ]);

    const reviewReports = reviewResults.map((result) =>
      parseProgressiveReviewReport(result?.summary, "review"),
    );
    const reviewReport = {
      verdict: reviewReports.every((report) => report.verdict === "pass")
        ? "pass"
        : reviewReports.some((report) => report.verdict === "needs_changes")
          ? "needs_changes"
          : "uncertain",
      checks: reviewReports.flatMap((report) => report.checks || []),
      findings: reviewReports.flatMap((report) => report.findings || []),
      remainingRisks: reviewReports.flatMap(
        (report) => report.remainingRisks || [],
      ),
      parseError: reviewReports.some((report) => report.parseError),
    };
    const reviewEvidence = reviewResults.flatMap(
      (result) => result?.evidence || [],
    );
    const missingReviewEvidence = pendingChanges
      .filter((change) =>
        !reviewEvidence.some((item) =>
          reviewEvidenceCoversChange(change, item),
        ),
      )
      .map((change) => change.path);
    if (
      reviewResults.some((result) => result?.status !== "completed") ||
      missingReviewEvidence.length
    ) {
      reviewReport.verdict = "uncertain";
      reviewReport.parseError = true;
      reviewReport.remainingRisks.push(
        missingReviewEvidence.length
          ? `缺少文件读取证据：${missingReviewEvidence.join(", ")}`
          : "审查子 Agent 未正常完成。",
      );
    }
    if (
      reviewReport.findings.some((finding) =>
        ["critical", "high", "medium"].includes(finding.severity),
      )
    ) {
      reviewReport.verdict = "needs_changes";
    }

    const verifyReport = verificationCandidates.length
      ? parseProgressiveReviewReport(verifyResult?.summary, "verify")
      : {
          verdict: "not_run",
          checks: [],
          commands: [],
          remainingRisks: [],
          parseError: false,
        };
    const observedCommands = (verifyResult?.evidence || [])
      .filter(
        (item) =>
          item?.tool === "run_command" &&
          item.command &&
          findVerificationCandidate(verificationCandidates, {
            command: item.command,
            cwd: item.cwd || ".",
          }),
      )
      .map((item) => ({
        command: item.command,
        cwd: item.cwd || ".",
        passed: item.exitCode === 0,
        exitCode: item.exitCode,
        error: item.error || null,
      }));
    if (verificationCandidates.length) {
      if (verifyResult?.status !== "completed" || !observedCommands.length) {
        verifyReport.verdict = "uncertain";
        verifyReport.parseError = true;
        verifyReport.remainingRisks.push(
          "验证子 Agent 没有留下可核验的命令执行证据。",
        );
      } else {
        verifyReport.commands = observedCommands;
        verifyReport.verdict = observedCommands.every(
          (command) => command.passed,
        )
          ? "pass"
          : "fail";
        selfCheck.verificationAttempted = true;
        selfCheck.verificationPassed = observedCommands.every(
          (command) => command.passed,
        );
        for (const command of observedCommands) {
          selfCheck.verificationResults.push(command);
        }
      }
    }

    if (reviewReport.verdict === "pass") {
      for (const [path, version] of versions) {
        if (changeMap.get(path)?.afterContent === version) {
          selfCheck.reviewedVersions.set(path, version);
        }
      }
    }
    segment.reviewAgentIds = reviewResults
      .map((result) => result?.agentId)
      .filter(Boolean);
    segment.reviewAgentId = segment.reviewAgentIds[0] || null;
    segment.verifyAgentId = verifyResult?.agentId || null;
    segment.findings = reviewReport.findings;
    segment.checks = [...reviewReport.checks, ...verifyReport.checks];
    segment.remainingRisks = [
      ...reviewReport.remainingRisks,
      ...verifyReport.remainingRisks,
      ...(verifyReport.verdict === "fail"
        ? ["项目验证命令未通过，失败证据已保留。"]
        : []),
    ];
    segment.verdict =
      reviewReport.verdict === "needs_changes" ||
      verifyReport.verdict === "fail"
        ? "needs_changes"
        : reviewReport.verdict === "pass" &&
            ["pass", "not_run"].includes(verifyReport.verdict)
          ? "pass"
          : "uncertain";
    segment.status = "completed";
    segment.completedAt = new Date().toISOString();
    emit({
      type: "self_check.segment.completed",
      segmentId,
      reason,
      planStepId,
      verdict: segment.verdict,
      paths: segment.paths,
      findings: segment.findings,
      checks: segment.checks,
      remainingRisks: segment.remainingRisks,
      reviewAgentId: segment.reviewAgentId,
      reviewAgentIds: segment.reviewAgentIds,
      verifyAgentId: segment.verifyAgentId,
    });
    return segment;
  };

  const segmentMatchesCurrentVersions = (segment) =>
    Boolean(
      segment?.versions &&
        [...segment.versions.entries()].every(
          ([path, version]) => changeMap.get(path)?.afterContent === version,
        ),
    );

  const buildReviewFeedback = (segment) => {
    if (
      !segment ||
      segment.feedbackDelivered ||
      segment.verdict !== "needs_changes"
    ) {
      return "";
    }
    segment.feedbackDelivered = true;
    if (!segmentMatchesCurrentVersions(segment)) return "";
    const findings = Array.isArray(segment.findings) ? segment.findings : [];
    if (!findings.length) return "";
    return [
      "AporiaX background Review subagent found issues in the latest unchanged file versions.",
      "Address these findings before continuing. Do not merely restate them:",
      JSON.stringify(findings),
      segment.remainingRisks?.length
        ? `Uncertainty: ${JSON.stringify(segment.remainingRisks)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const describeJob = (job) => ({
    scheduled: true,
    status: job?.status || "running",
    segmentId: job?.result?.id || null,
    paths: job?.paths || [],
  });

  const scheduleSegment = (options) => {
    if (progressiveReviewJob && !progressiveReviewJob.consumed) {
      return describeJob(progressiveReviewJob);
    }
    const paths = currentPendingChanges().map((change) => change.path);
    if (!paths.length && !options.runVerification) return null;
    const job = {
      status: "running",
      consumed: false,
      paths,
      result: null,
      promise: null,
    };
    job.promise = runSegment(options)
      .then((segment) => {
        job.status = "completed";
        job.result = segment;
        return segment;
      })
      .catch((error) => {
        job.status = "failed";
        job.error = String(error?.message || error).slice(0, 800);
        emit({
          type: "self_check.segment.failed",
          error: job.error,
          paths: job.paths,
        });
        return null;
      });
    progressiveReviewJob = job;
    return describeJob(job);
  };

  const consumeReviewJob = async ({ wait = false } = {}) => {
    const job = progressiveReviewJob;
    if (!job || job.consumed) return "";
    if (wait) await job.promise;
    if (job.status === "running") return "";
    job.consumed = true;
    return buildReviewFeedback(job.result);
  };

  const seal = async () => {
    const pendingPaths = currentPendingChanges().map((change) => change.path);
    if (pendingPaths.length) return null;
    if (
      selfCheck.verificationCandidates.length > 0 &&
      !selfCheck.verificationAttempted
    ) {
      return null;
    }
    const currentChanges = reviewableChanges(changeMap);
    const currentSignature = createChangeVersionSignature(currentChanges);
    const remainingRisks = [
      ...new Set(
        selfCheck.segments.flatMap(
          (segment) => segment.remainingRisks || [],
        ),
      ),
    ];
    if (
      selfCheck.verificationCandidates.length &&
      !selfCheck.verificationPassed &&
      !remainingRisks.some((risk) => /验证|verification|command/i.test(risk))
    ) {
      remainingRisks.push("项目验证命令未通过，仍需人工确认运行结果。");
    }
    if (!selfCheck.verificationCandidates.length) {
      remainingRisks.push("未发现可执行的项目验证脚本，已完成分段静态复核。");
    }
    const unreviewableBinaryPaths = buildChanges(changeMap)
      .filter(
        (change) =>
          change.binary &&
          !change.afterMissing &&
          !isOfficePath(change.path),
      )
      .map((change) => change.path);
    if (unreviewableBinaryPaths.length) {
      remainingRisks.push(
        `以下二进制产物未进行内容级复核：${unreviewableBinaryPaths.join(", ")}`,
      );
    }
    if (
      buildChanges(changeMap).some(
        (change) =>
          change.binary &&
          isOfficePath(change.path) &&
          change.artifact?.visualQa !== "rendered",
      )
    ) {
      remainingRisks.push(
        "Office 文件已通过结构检查，最终视觉版式仍需在对应 Office 应用中确认。",
      );
    }
    selfCheck.mode = "progressive";
    selfCheck.started = true;
    selfCheck.completed = true;
    selfCheck.seal = {
      id: `seal-${Date.now()}`,
      createdAt: new Date().toISOString(),
      versionSignature: currentSignature,
      reviewedFiles: currentChanges.map((change) => change.path),
      segmentCount: selfCheck.segments.length,
      verificationAttempted: selfCheck.verificationAttempted,
      verificationPassed: selfCheck.verificationPassed,
    };
    selfCheck.report = {
      summary:
        language === "en"
          ? `${selfCheck.segments.length} staged subagent review segment(s) cover every current changed file version; the final evidence seal is complete.`
          : `${selfCheck.segments.length} 个分段子 Agent 自检已覆盖全部当前文件版本，最终证据封印完成。`,
      checks: [
        ...new Set(
          selfCheck.segments.flatMap((segment) => segment.checks || []),
        ),
      ].slice(0, 20),
      improvements: [
        ...new Set(
          selfCheck.segments.flatMap((segment) =>
            (segment.findings || []).map(
              (finding) => `${finding.path || "任务"}: ${finding.message}`,
            ),
          ),
        ),
      ].slice(0, 20),
      remainingRisks: [...new Set(remainingRisks)].slice(0, 20),
    };
    emit({ type: "self_check.sealed", seal: selfCheck.seal });
    emit({
      type: "self_check.completed",
      report: buildSelfCheckResult(selfCheck, changeMap),
    });
    return selfCheck.seal;
  };

  return Object.freeze({
    runSegment,
    scheduleSegment,
    consumeReviewJob,
    seal,
  });
}
