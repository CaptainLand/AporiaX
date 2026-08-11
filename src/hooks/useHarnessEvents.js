import { useEffect } from "react";
import {
  closeRunningRouteEntries,
  getRouteToolMeta,
  updateRunAssistant,
} from "../p0-model";
import {
  PURE_TASK_EVENT_TYPES,
  reduceHarnessTaskEvent,
} from "../state/harness-event-reducer.js";

/**
 * Owns the renderer subscription to the Harness event protocol.
 *
 * This extraction deliberately preserves the existing event branches byte-for-byte
 * apart from their module boundary. Follow-up work can make the reducers pure and
 * test them independently without keeping protocol handling inside App.jsx.
 */
export function useHarnessEvents({
  language,
  tr,
  runsRef,
  setTasks,
  setRunPaused,
  setRunStatus,
  setSandboxStatus,
  setApproval,
  normalizeWorkspacePath,
}) {
  useEffect(() => {
    if (!window.desktop?.harness?.onEvent) return undefined;

    // Provider SSE can produce many tiny deltas per second. Updating the full
    // TaskStore for every fragment creates renderer backpressure, especially in
    // long conversations where Markdown and historical turns are also present.
    // Buffer only presentation deltas for one short frame; the Provider stream
    // itself remains unthrottled and the final Harness result is unchanged.
    const STREAM_FLUSH_MS = 24;
    const pendingDeltas = new Map();
    let streamFlushTimer = null;

    const flushPendingDeltas = () => {
      if (!pendingDeltas.size) return;
      const batch = [...pendingDeltas.entries()];
      pendingDeltas.clear();
      setTasks((current) => {
        let next = current;
        for (const [runId, delta] of batch) {
          const bufferedRun = runsRef.current.get(runId);
          if (!bufferedRun || !delta) continue;
          next = updateRunAssistant(next, bufferedRun, (message) => ({
            ...message,
            content: `${message.content || ""}${delta}`,
          }));
        }
        return next;
      }, { type: "stream.delta.flush", batchSize: batch.length });
    };

    const scheduleDeltaFlush = () => {
      if (streamFlushTimer !== null) return;
      streamFlushTimer = window.setTimeout(() => {
        streamFlushTimer = null;
        flushPendingDeltas();
      }, STREAM_FLUSH_MS);
    };

    const discardPendingDelta = (runId) => {
      pendingDeltas.delete(runId);
    };

    const toolLabels = {
      delegate_subagent: tr("正在委派子 Agent", "Delegating to a subagent"),
      collect_subagents: tr("正在收集子 Agent 结果", "Collecting subagent results"),
      remember_project_fact: tr("正在提交项目理解候选", "Proposing Project Understanding"),
      list_directory: tr("正在浏览工作区", "Browsing workspace"),
      read_file: tr("正在读取文件", "Reading file"),
      search_text: tr("正在搜索代码", "Searching code"),
      git_status: tr("正在检查 Git 状态", "Inspecting Git status"),
      git_diff: tr("正在读取代码差异", "Reading code diff"),
      write_file: tr("正在修改文件", "Writing file"),
      apply_patch: tr("正在精确修改代码", "Applying a precise code patch"),
      create_word_document: tr("正在生成 Word 文档", "Creating Word document"),
      create_presentation: tr("正在生成 PowerPoint", "Creating PowerPoint presentation"),
      create_spreadsheet: tr("正在生成 Excel 工作簿", "Creating Excel workbook"),
      inspect_office_file: tr("正在检查 Office 工件", "Inspecting Office artifact"),
      run_command: tr("正在准备验证命令", "Preparing verification command"),
      browser_open: tr("正在打开浏览器页面", "Opening browser page"),
      browser_snapshot: tr("正在观察页面结构", "Inspecting page structure"),
      browser_click: tr("正在点击页面元素", "Clicking page element"),
      browser_fill: tr("正在填写页面内容", "Filling page input"),
      browser_press: tr("正在发送键盘操作", "Sending keyboard input"),
      browser_screenshot: tr("正在保存页面快照", "Capturing page screenshot"),
      browser_console: tr("正在检查浏览器控制台", "Inspecting browser console"),
      browser_network: tr("正在检查网络请求", "Inspecting browser network"),
      browser_close: tr("正在关闭浏览器会话", "Closing browser session"),
      update_plan: tr("正在更新执行计划", "Updating the execution plan"),
      complete_self_check: tr("正在提交自检报告", "Submitting self-check report"),
    };
    const unsubscribe = window.desktop.harness.onEvent((event) => {
      const run = runsRef.current.get(event.runId);
      if (!run) return;
      const reduceTaskEvent = (targetEvent = event) => {
        if (!PURE_TASK_EVENT_TYPES.has(targetEvent.type)) return;
        setTasks((current) =>
          reduceHarnessTaskEvent(current, run, targetEvent, { language, tr }),
        );
      };

      if (event.type === "skill.activated") {
        reduceTaskEvent();
        return;
      }

      if (event.type === "skill.unresolved") {
        reduceTaskEvent();
        return;
      }

      if (event.type === "control.paused") {
        setRunPaused(true);
        setRunStatus({
          title: tr("任务已暂停", "Task paused"),
          detail: tr(
            "已停在安全边界；可以补充要求、检查 Route，或继续运行",
            "Stopped at a safe boundary. Add guidance, inspect Route, or resume.",
          ),
        });
        return;
      }

      if (event.type === "control.resumed") {
        setRunPaused(false);
        setRunStatus({
          title: tr("正在继续任务", "Resuming task"),
          detail: tr(
            "将从已保留的上下文与工作区状态继续",
            "Continuing with the preserved context and workspace state",
          ),
        });
        return;
      }

      if (event.type === "steering.queued") {
        setRunStatus({
          title: tr("已收到新的执行要求", "New guidance received"),
          detail: tr(
            "将在下一安全边界合并到当前任务",
            "It will be merged into the current task at the next safe boundary",
          ),
        });
        return;
      }

      if (event.type === "steering.applied") {
        const messageIds = new Set(event.messageIds || []);
        setTasks((current) =>
          current.map((task) =>
            task.id === run.taskId
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    messageIds.has(message.id)
                      ? {
                          ...message,
                          queued: false,
                          steeringStatus: "applied",
                          appliedAt: new Date().toISOString(),
                        }
                      : message,
                  ),
                }
              : task,
          ),
        );
        setRunStatus({
          title: tr("新要求已接入当前任务", "Guidance applied to the current task"),
          detail: tr(
            "AporiaX 正在依据新要求调整后续步骤",
            "AporiaX is adapting the remaining steps to the new guidance",
          ),
        });
        return;
      }

      if (event.type === "plan.updated") {
        reduceTaskEvent();
        const activeStep = event.plan?.steps?.find(
          (step) => step.status === "in_progress",
        );
        setRunStatus({
          title: tr("执行计划已更新", "Execution plan updated"),
          detail:
            activeStep?.title ||
            tr(
              "Route 已同步为模型当前的真实计划",
              "Route now reflects the model's current plan",
            ),
        });
        return;
      }

      if (event.type === "turn.started") {
        setRunPaused(false);
        if (event.sandbox) setSandboxStatus(event.sandbox);
        run.sandbox = event.sandbox || null;
        run.approvalMode = event.approvalMode || "manual";
        return;
      }

      if (event.type === "witness.updated") {
        reduceTaskEvent();
        return;
      }

      if (event.type === "response.reset") {
        discardPendingDelta(event.runId);
        reduceTaskEvent();
        setRunStatus({
          title:
            event.phase === "self-check"
              ? tr("AporiaX 正在强制自检", "AporiaX is running its mandatory self-check")
              : tr("AporiaX 正在生成", "AporiaX is responding"),
          detail:
            event.phase === "self-check"
              ? tr("正在重新读取本轮修改的代码并检查可改进项", "Re-reading this turn's changes and looking for improvements")
              : event.round > 1
                ? tr("正在处理第 {round} 轮工具结果", "Processing tool results from round {round}", { round: event.round })
                : tr("正在理解任务并规划操作", "Understanding the task and planning actions"),
        });
        return;
      }

      if (event.type === "response.delta") {
        const delta = String(event.delta || "");
        if (delta) {
          pendingDeltas.set(
            event.runId,
            `${pendingDeltas.get(event.runId) || ""}${delta}`,
          );
          scheduleDeltaFlush();
        }
        return;
      }

      if (event.type === "response.retry") {
        discardPendingDelta(event.runId);
        setTasks((current) =>
          current.map((task) =>
            task.id === run.taskId
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    message.id === run.assistantId
                      ? { ...message, content: "" }
                      : message,
                  ),
                }
              : task,
          ),
        );
        setRunStatus({
          title: tr(
            "{provider} 正在自动重试 {attempt}/{max}",
            "{provider} is retrying automatically {attempt}/{max}",
            {
              provider: event.provider || tr("模型服务", "Model service"),
              attempt: event.attempt,
              max: event.maxAttempts,
            },
          ),
          detail: tr("请求暂时无响应或服务繁忙，已保留本轮任务状态", "The request timed out or the service is busy. This turn's state has been preserved."),
        });
        return;
      }

      if (event.type === "context.compacted") {
        setRunStatus({
          title: tr("正在压缩长任务上下文", "Compacting long task context"),
          detail: tr("已压缩 {count} 条旧工具输出，保留最近操作", "Compacted {count} older tool outputs while retaining recent actions", { count: event.compactedMessages || 0 }),
        });
        return;
      }

      if (event.type === "subagent.started") {
        setRunStatus({
          title: tr(
            "子 Agent 正在独立处理任务",
            "A subagent is working independently",
          ),
          detail:
            event.task ||
            tr("探索、审查或验证正在独立上下文中进行", "Exploration, review, or verification is running in an isolated context"),
        });
        return;
      }

      if (event.type === "subagent.tool.started") {
        const meta = getRouteToolMeta(
          event.tool,
          ["review", "verify"].includes(event.role) ? "self-check" : "work",
          language,
          event.capability,
        );
        reduceTaskEvent();
        setRunStatus({
          title: tr(
            "子 Agent 正在收集证据",
            "Subagent is collecting evidence",
          ),
          detail:
            event.path ||
            event.command ||
            meta.activity ||
            toolLabels[event.tool] ||
            event.tool,
        });
        return;
      }

      if (event.type === "subagent.tool.completed") {
        reduceTaskEvent();
        return;
      }

      if (
        event.type === "subagent.completed" ||
        event.type === "subagent.failed"
      ) {
        setRunStatus({
          title:
            event.type === "subagent.completed"
              ? tr("子 Agent 已返回结果", "Subagent returned its result")
              : tr("子 Agent 未能完成", "Subagent did not complete"),
          detail:
            event.summary ||
            event.error ||
            tr("主 Agent 将整理证据并继续任务", "The parent agent will integrate the evidence and continue"),
        });
        return;
      }

      if (event.type === "understanding.candidate.staged") {
        setRunStatus({
          title: tr("项目理解候选已暂存", "Understanding candidate staged"),
          detail:
            event.candidate?.content ||
            tr(
              "任务结束前将由 Curator 子 Agent 复核，不会直接写入",
              "The Curator subagent will review it before the task ends; it has not been committed yet",
            ),
        });
        return;
      }

      if (event.type === "understanding.curating") {
        setRunStatus({
          title: tr("正在整理项目理解", "Curating Project Understanding"),
          detail: tr(
            "Curator 子 Agent 正在核对本轮证据并提炼可跨任务复用的理解",
            "The Curator subagent is validating evidence and extracting reusable cross-task understanding",
          ),
        });
        return;
      }

      if (event.type === "understanding.updated") {
        setTasks((current) => {
          const sourceTask = current.find((task) => task.id === run.taskId);
          const workspaceKey = normalizeWorkspacePath(sourceTask?.workspacePath);
          return current.map((task) =>
            workspaceKey && normalizeWorkspacePath(task.workspacePath) === workspaceKey
              ? { ...task, understandingRevision: event.revision }
              : task,
          );
        });
        setRunStatus({
          title: tr("项目理解已形成新修订", "Project Understanding revision created"),
          detail:
            event.summary ||
            tr(
              "同一工作区的后续任务将读取这份带证据的理解",
              "Future tasks in this workspace will read this evidence-backed understanding",
            ),
        });
        return;
      }

      if (event.type === "understanding.failed") {
        setRunStatus({
          title: tr("项目理解未更新", "Project Understanding was not updated"),
          detail:
            event.error ||
            tr(
              "主任务已完成；本次自动整理没有形成可靠的理解增量",
              "The main task completed, but automatic curation produced no reliable delta",
            ),
        });
        return;
      }

      if (event.type === "memory.updated") {
        setRunStatus({
          title: tr("项目记忆已更新", "Project memory updated"),
          detail:
            event.fact?.content ||
            tr("可复用的项目知识会用于后续任务", "Reusable project knowledge will be available to future tasks"),
        });
        return;
      }

      if (event.type === "tool.started") {
        const meta = getRouteToolMeta(
          event.tool,
          event.phase,
          language,
          event.capability,
        );
        reduceTaskEvent();
        setRunStatus({
          title:
            meta.activity ||
            toolLabels[event.tool] ||
            tr("Harness 正在运行", "Harness is running"),
          detail:
            event.path ||
            event.command ||
            event.detail ||
            (event.tool === "run_command"
              ? run.approvalMode === "sandbox-auto"
                ? tr(
                    run.sandbox?.available
                      ? "命令将在 Docker 强隔离沙箱内自动执行"
                      : "命令将在本地临时工作区内自动执行",
                    run.sandbox?.available
                      ? "The command will run automatically in the strongly isolated Docker sandbox"
                      : "The command will run automatically in a temporary local workspace",
                  )
                : tr(
                    "命令正在等待手动批准",
                    "The command is waiting for manual approval",
                  )
              : event.phase === "self-check"
                ? tr("强制复核本轮修改，发现问题会继续修复", "Reviewing this turn's changes and continuing to fix any issues")
                : tr("操作范围限制在当前工作区内", "Actions are limited to the current workspace")),
        });
        return;
      }

      if (event.type === "tool.completed") {
        reduceTaskEvent();
        setRunStatus({
          title: event.skipped
            ? tr("检查不适用于当前工作区", "Check is not applicable to this workspace")
            : event.retry
              ? event.tool === "complete_self_check"
                ? tr("自检条件尚未满足", "Self-check conditions are not yet satisfied")
                : tr("工具参数将自动重试", "Tool arguments will be retried automatically")
              : event.success
                ? tr("操作已完成", "Action completed")
                : tr("操作未完成", "Action incomplete"),
          detail:
            event.detail ||
            (event.success
              ? tr("正在整理结果并决定下一步", "Organizing results and deciding the next step")
              : tr("Agent 正在根据错误调整方案", "The agent is adjusting its plan based on the error")),
        });
        return;
      }

      if (event.type === "file.changed") {
        reduceTaskEvent();
        return;
      }

      if (event.type === "self_check.segment.started") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...(message.route || []),
              {
                id: `${event.runId}-${event.segmentId}`,
                kind: "self-check-segment",
                stage: "trial",
                title: tr("分段子 Agent 自检", "Staged subagent review"),
                detail: tr(
                  "复核 {count} 个当前文件版本",
                  "Reviewing {count} current file version(s)",
                  { count: event.paths?.length || 0 },
                ),
                status: "running",
                startedAt: now,
                planStepId: event.planStepId || null,
              },
            ],
          })),
        );
        setRunStatus({
          title: tr("分段自检进行中", "Staged review in progress"),
          detail: tr(
            "审查与验证子 Agent 正在检查最新改动",
            "Review and verify subagents are checking the latest changes",
          ),
        });
        return;
      }

      if (event.type === "self_check.segment.completed") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: (message.route || []).map((entry) =>
              entry.id === `${event.runId}-${event.segmentId}`
                ? {
                    ...entry,
                    status: event.verdict === "pass" ? "completed" : "failed",
                    detail: event.findings?.[0]?.message ||
                      tr(
                        "已保存这一阶段的审查证据",
                        "Review evidence for this stage was saved",
                      ),
                    finishedAt: now,
                  }
                : entry,
            ),
          })),
        );
        setRunStatus({
          title: event.verdict === "pass"
            ? tr("本阶段自检通过", "Stage review passed")
            : tr("本阶段需要修正", "Stage needs corrections"),
          detail: event.findings?.[0]?.message ||
            tr("审查证据已写入版本账本", "Review evidence was written to the version ledger"),
        });
        return;
      }

      if (event.type === "self_check.fallback") {
        setRunStatus({
          title: tr("启用完整自检兜底", "Full self-check fallback enabled"),
          detail: tr(
            "分段证据不完整，将由主 Agent 完成全量复核",
            "Staged evidence was incomplete; the main agent will perform a full review",
          ),
        });
        return;
      }

      if (event.type === "self_check.sealed") {
        setRunStatus({
          title: tr("最终证据已封印", "Final evidence sealed"),
          detail: tr(
            "{count} 个当前文件版本均已有匹配审查记录",
            "All {count} current file version(s) have matching review records",
            { count: event.seal?.reviewedFiles?.length || 0 },
          ),
        });
        return;
      }

      if (event.type === "self_check.started") {
        if (event.mode === "progressive") {
          setRunStatus({
            title: tr("准备最终证据封印", "Preparing the final evidence seal"),
            detail: tr(
              "正在核对分段审查账本与当前文件版本",
              "Checking staged review records against current file versions",
            ),
          });
          return;
        }
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...closeRunningRouteEntries(message.route, now),
              {
                id: `${event.runId}-self-check-start`,
                kind: "self-check-start",
                stage: "trial",
                title: tr("进入强制自检", "Begin mandatory self-check"),
                detail: tr("复核 {count} 个修改文件", "Review {count} changed file(s)", { count: event.paths?.length || 0 }),
                status: "completed",
                startedAt: now,
                finishedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: tr("进入强制自检", "Begin mandatory self-check"),
          detail: event.verificationCandidates?.length
            ? tr("复核 {count} 个文件，并尝试项目构建或测试", "Review {count} file(s), then attempt the project build or tests", { count: event.paths?.length || 0 })
            : tr("必须重新读取 {count} 个修改文件后才能完成任务", "All {count} changed file(s) must be re-read before the task can finish", { count: event.paths?.length || 0 }),
        });
        return;
      }

      if (event.type === "self_check.completed") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...closeRunningRouteEntries(message.route, now),
              {
                id: `${event.runId}-self-check-complete`,
                kind: "self-check-complete",
                stage: "trial",
                title: event.report?.mode === "progressive"
                  ? tr("最终证据封印完成", "Final evidence seal completed")
                  : tr("强制自检已完成", "Mandatory self-check completed"),
                detail: event.report?.verification?.passed
                  ? tr("项目验证已通过", "Project verification passed")
                  : tr("已复核 {count} 个文件", "Reviewed {count} file(s)", { count: event.report?.reviewedFiles?.length || 0 }),
                status: "completed",
                startedAt: now,
                finishedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: tr("强制自检已通过", "Mandatory self-check passed"),
          detail: tr("已复核 {count} 个修改文件，正在整理最终答复", "Reviewed {count} changed file(s); preparing the final response", { count: event.report?.reviewedFiles?.length || 0 }),
        });
        return;
      }

      if (event.type === "turn.completed") {
        if (streamFlushTimer !== null) {
          window.clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        flushPendingDeltas();
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...closeRunningRouteEntries(message.route, now),
              ...((message.route || []).some(
                (entry) => entry.stage === "deliver",
              )
                ? []
                : [
                    {
                      id: `${event.runId}-deliver`,
                      stage: "deliver",
                      title: tr("整理最终产物", "Prepare final deliverables"),
                      status: "completed",
                      startedAt: now,
                      finishedAt: now,
                    },
                  ]),
            ],
          })),
        );
        return;
      }

      if (event.type === "approval.required") {
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => {
            const route = [...(message.route || [])];
            const routeIndex = route.findLastIndex(
              (entry) => entry.status === "running",
            );
            if (routeIndex >= 0) {
              route[routeIndex] = {
                ...route[routeIndex],
                status: "waiting",
              };
            }
            return { ...message, route };
          }),
        );
        setApproval({
          ...event.approval,
          runId: event.runId,
          taskId: run.taskId,
        });
        setRunStatus({
          title: tr("等待命令审批", "Awaiting command approval"),
          detail: event.approval?.sandbox?.available
            ? tr(
                "确认后 Harness 将在隔离的 Docker 容器中执行该命令",
                "After approval, Harness will run this command in the isolated Docker container",
              )
            : tr(
                "确认后 Harness 将在本地临时工作区中执行该命令",
                "After approval, Harness will run this command in a temporary local workspace",
              ),
        });
      }
    });

    return () => {
      if (streamFlushTimer !== null) {
        window.clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
      pendingDeltas.clear();
      unsubscribe?.();
    };
  }, [language, tr]);
}
