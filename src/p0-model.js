export const ROUTE_STAGE_ORDER = [
  "lens",
  "route",
  "forge",
  "trial",
  "deliver",
];

export const ROUTE_STAGE_META = {
  lens: {
    label: "Lens",
    title: "理解与观察",
  },
  route: {
    label: "Route",
    title: "确定行动路径",
  },
  forge: {
    label: "Forge",
    title: "创建与修改",
  },
  trial: {
    label: "Trial",
    title: "测试与验证",
  },
  deliver: {
    label: "Deliver",
    title: "整理交付",
  },
};

const ROUTE_TOOL_META = {
  list_directory: { stage: "lens", zh: "浏览工作区", en: "Browse workspace" },
  read_file: { stage: "lens", zh: "读取文件", en: "Read file" },
  search_text: { stage: "lens", zh: "定位相关内容", en: "Locate relevant content" },
  git_status: { stage: "lens", zh: "检查 Git 状态", en: "Inspect Git status" },
  git_diff: { stage: "lens", zh: "检查代码差异", en: "Inspect code diff" },
  write_file: { stage: "forge", zh: "写入文件", en: "Write file" },
  apply_patch: { stage: "forge", zh: "修改代码", en: "Patch code" },
  create_word_document: { stage: "forge", zh: "创建 Word 文档", en: "Create Word document" },
  create_presentation: { stage: "forge", zh: "创建演示文稿", en: "Create presentation" },
  create_spreadsheet: { stage: "forge", zh: "创建电子表格", en: "Create spreadsheet" },
  inspect_office_file: { stage: "trial", zh: "检查 Office 文件", en: "Inspect Office file" },
  run_command: { stage: "trial", zh: "运行验证命令", en: "Run verification command" },
  complete_self_check: { stage: "trial", zh: "提交自检结果", en: "Submit self-check result" },
};

export function getRouteToolMeta(tool, phase, language = "zh-CN") {
  const meta = ROUTE_TOOL_META[tool] || {
    stage: phase === "self-check" ? "trial" : "route",
    zh: "执行工具",
    en: "Run tool",
  };
  return {
    ...meta,
    stage:
      phase === "self-check" && meta.stage !== "forge"
        ? "trial"
        : meta.stage,
    title: language === "en" ? meta.en : meta.zh,
  };
}

export function updateRunAssistant(tasks, run, updater) {
  return tasks.map((task) =>
    task.id === run.taskId
      ? {
          ...task,
          messages: task.messages.map((message) =>
            message.id === run.assistantId ? updater(message) : message,
          ),
        }
      : task,
  );
}

export function closeRunningRouteEntries(route, finishedAt) {
  return (route || []).map((entry) =>
    entry.status === "running"
      ? { ...entry, status: "completed", finishedAt }
      : entry,
  );
}

function markRecoveredAttempts(entries) {
  return entries.map((entry, index) => {
    if (!["failed", "retry"].includes(entry.status) || !entry.tool) {
      return entry;
    }
    const recovered = entries
      .slice(index + 1)
      .some(
        (candidate) =>
          candidate.tool === entry.tool &&
          ["completed", "recovered"].includes(candidate.status),
      );
    return recovered
      ? {
          ...entry,
          status: "recovered",
          detail: entry.detail || "后续重试已成功",
        }
      : entry;
  });
}

export function enrichRouteEntries(route, steps, result) {
  const stepQueue = [...(steps || [])];
  const enriched = (route || []).map((entry) => {
    if (!entry.tool) return entry;
    const matchingIndex = stepQueue.findIndex(
      (step) => step.name === entry.tool,
    );
    if (matchingIndex < 0) return entry;
    const [step] = stepQueue.splice(matchingIndex, 1);
    return {
      ...entry,
      status: step.skipped
        ? "skipped"
        : step.retry
          ? "retry"
          : step.success
            ? "completed"
            : "failed",
      detail: step.detail || entry.detail || null,
      path: step.path || entry.path || null,
      command: step.command || entry.command || null,
      additions: step.additions || 0,
      deletions: step.deletions || 0,
      artifact: step.artifact || null,
      exitCode: step.exitCode,
    };
  });

  for (const [index, step] of stepQueue.entries()) {
    const meta = getRouteToolMeta(step.name, "work");
    enriched.push({
      id: `restored-${index}-${step.name}-${step.path || ""}`,
      stage: meta.stage,
      title: meta.title,
      tool: step.name,
      status: step.skipped
        ? "skipped"
        : step.retry
          ? "retry"
          : step.success
            ? "completed"
            : "failed",
      detail: step.detail || null,
      path: step.path || null,
      command: step.command || null,
      additions: step.additions || 0,
      deletions: step.deletions || 0,
      artifact: step.artifact || null,
      exitCode: step.exitCode,
    });
  }

  if (
    result?.selfCheck?.required &&
    !enriched.some((entry) => entry.kind === "self-check-complete")
  ) {
    enriched.push({
      id: `self-check-${result.status || "completed"}`,
      kind: "self-check-complete",
      stage: "trial",
      title: result.selfCheck.completed
        ? "强制自检已完成"
        : "强制自检未完成",
      detail: result.selfCheck.verification?.passed
        ? "项目验证已通过"
        : "保留未验证项",
      status: result.selfCheck.completed ? "completed" : "failed",
    });
  }

  if (!enriched.some((entry) => entry.stage === "deliver")) {
    enriched.push({
      id: `deliver-${result?.status || "completed"}`,
      stage: "deliver",
      title:
        result?.status === "failed"
          ? "保留已完成的结果"
          : result?.status === "interrupted"
            ? "任务已停止"
            : "整理最终产物",
      status: result?.status === "failed" ? "failed" : "completed",
    });
  }

  return markRecoveredAttempts(enriched);
}

export function routeEntriesFromMessage(message) {
  if (message.route?.length) {
    const normalized = message.route.map((entry) => {
      const localizedDetail = /Invalid arguments/i.test(
        entry.detail || "",
      )
        ? "工具参数格式无效，Agent 已重新生成参数"
        : /Mandatory self-check has not started yet/i.test(
              entry.detail || "",
            )
          ? "Harness 已进入强制自检并继续复核"
          : entry.detail;
      if (
        entry.tool === "complete_self_check" &&
        entry.status === "failed"
      ) {
        return {
          ...entry,
          status: "retry",
          detail:
            localizedDetail ||
            "提交条件未满足，Harness 已继续补充检查",
        };
      }
      if (
        entry.tool === "git_status" &&
        entry.status === "failed" &&
        !entry.detail
      ) {
        return {
          ...entry,
          status: "skipped",
          detail: "当前工作区未启用 Git，已跳过该检查",
        };
      }
      return localizedDetail !== entry.detail
        ? { ...entry, detail: localizedDetail }
        : entry;
    });
    return markRecoveredAttempts(normalized);
  }
  if (!message.steps?.length && message.changes?.length) {
    const restoredChanges = message.changes.map((change, index) => ({
      id: `legacy-change-${message.id}-${index}`,
      stage: "forge",
      title: change.created
        ? `创建 ${change.path.split(/[\\/]/).pop()}`
        : `修改 ${change.path.split(/[\\/]/).pop()}`,
      status: "completed",
      path: change.path,
      additions: change.additions || 0,
      deletions: change.deletions || 0,
      artifact: change.artifact || null,
      detail: change.reverted ? "该项修改已回退" : null,
    }));
    return enrichRouteEntries(restoredChanges, [], {
      status: message.status,
      selfCheck: message.selfCheck,
    });
  }
  if (!message.steps?.length) return [];
  return enrichRouteEntries([], message.steps, {
    status: message.status,
    selfCheck: message.selfCheck,
  });
}

export function collectTaskRouteEntries(task) {
  return collectTaskRouteRuns(task).flatMap((run) => run.entries);
}

export function collectTaskRouteRuns(task) {
  const messages = task?.messages || [];
  const userMessages = new Map(
    messages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message]),
  );

  return messages
    .filter((message) => message.role === "assistant")
    .map((message, index) => {
      const entries = routeEntriesFromMessage(message);
      const sourceMessage = userMessages.get(message.sourceUserId);
      return {
        id: message.id,
        messageId: message.id,
        prompt:
          sourceMessage?.content ||
          message.prompt ||
          `任务 ${index + 1}`,
        createdAt: message.createdAt || sourceMessage?.createdAt || null,
        completedAt: message.completedAt || null,
        status: message.status || "completed",
        entries,
        changes: message.changes || [],
        selfCheck: message.selfCheck || null,
      };
    })
    .filter(
      (run) =>
        run.entries.length > 0 ||
        run.changes.length > 0 ||
        run.status === "running",
    );
}

export function collectLatestDeliverables(task) {
  const messages = [...(task?.messages || [])].reverse();
  const message = messages.find(
    (candidate) =>
      candidate.role === "assistant" &&
      (candidate.changes || []).some((change) => !change.reverted),
  );

  if (!message) {
    return {
      messageId: null,
      completedAt: null,
      files: [],
    };
  }

  const files = new Map();
  for (const change of message.changes || []) {
    files.set(change.path, {
      ...change,
      messageId: message.id,
      completedAt: message.completedAt || message.createdAt,
      selfCheck: message.selfCheck || null,
    });
  }

  return {
    messageId: message.id,
    completedAt: message.completedAt || message.createdAt || null,
    files: [...files.values()].filter((file) => !file.reverted),
  };
}

export function collectTaskDeliverables(task) {
  return collectLatestDeliverables(task).files;
}

export function getDeliverableType(file) {
  if (file.artifact?.label) return file.artifact.label;
  const extension = file.path.split(".").pop()?.toLowerCase();
  const labels = {
    docx: "Word",
    pptx: "PowerPoint",
    xlsx: "Excel",
    html: "HTML",
    htm: "HTML",
    pdf: "PDF",
    js: "JavaScript",
    jsx: "React",
    ts: "TypeScript",
    tsx: "React",
    css: "CSS",
    md: "Markdown",
    json: "JSON",
  };
  return labels[extension] || extension?.toUpperCase() || "文件";
}

export function formatRouteDuration(entry) {
  if (!entry.startedAt || !entry.finishedAt) return "";
  const duration = new Date(entry.finishedAt) - new Date(entry.startedAt);
  if (!Number.isFinite(duration) || duration < 0) return "";
  return duration < 1000
    ? `${duration}ms`
    : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
}
