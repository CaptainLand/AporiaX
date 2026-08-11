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
  delegate_subagent: { stage: "lens", zh: "委派子 Agent", en: "Delegate subagent" },
  collect_subagents: { stage: "lens", zh: "收集子 Agent 结果", en: "Collect subagent results" },
  remember_project_fact: {
    stage: "route",
    zh: "提交项目理解候选",
    en: "Propose Project Understanding",
  },
  list_directory: { stage: "lens", zh: "浏览工作区", en: "Browse workspace" },
  read_file: { stage: "lens", zh: "读取文件", en: "Read file" },
  read_external_file: { stage: "lens", zh: "读取外部文件", en: "Read external file" },
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
  start_process: { stage: "trial", zh: "启动常驻进程", en: "Start persistent process" },
  read_process: { stage: "trial", zh: "读取进程输出", en: "Read process output" },
  write_stdin: { stage: "trial", zh: "写入进程输入", en: "Write process input" },
  kill_process: { stage: "trial", zh: "停止常驻进程", en: "Stop persistent process" },
  complete_self_check: { stage: "trial", zh: "提交自检结果", en: "Submit self-check result" },
};

export function getRouteToolMeta(tool, phase, language = "zh-CN", capability = null) {
  if (capability?.stage) {
    return {
      stage: capability.stage,
      zh: capability.titleZh || capability.title || tool || "执行工具",
      en: capability.titleEn || capability.title || tool || "Run tool",
      title:
        language === "en"
          ? capability.titleEn || capability.title || tool || "Run tool"
          : capability.titleZh || capability.title || tool || "执行工具",
      activity:
        language === "en"
          ? capability.activityEn || capability.titleEn || capability.title || tool
          : capability.activityZh || capability.titleZh || capability.title || tool,
      iconKey: capability.iconKey || null,
      source: capability.source || null,
      risk: capability.risk || null,
      capabilityId: capability.id || null,
    };
  }
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

const WITNESS_BLOCK_META = {
  understand: {
    label: "Context",
    zh: "理解任务与加载上下文",
    en: "Understand the task and load context",
  },
  explore: {
    label: "Explore",
    zh: "观察工作区并定位内容",
    en: "Inspect the workspace and locate relevant content",
  },
  plan: {
    label: "Route",
    zh: "确定行动路径",
    en: "Decide the action route",
  },
  execute: {
    label: "Build",
    zh: "创建与修改",
    en: "Create and modify",
  },
  verify: {
    label: "Evidence",
    zh: "检查与验证结果",
    en: "Inspect and verify the result",
  },
  coordinate: {
    label: "Control",
    zh: "等待确认并安全衔接",
    en: "Coordinate approval and safe continuation",
  },
  deliver: {
    label: "Result",
    zh: "整理本轮结果",
    en: "Prepare the result of this run",
  },
};

function witnessRecordBlockKind(record) {
  if (record?.kind === "tool" || record?.tool) {
    const stage = getRouteToolMeta(record.tool, record.phase, "zh-CN", record.capability).stage;
    if (stage === "lens") return "explore";
    if (stage === "forge") return "execute";
    if (stage === "trial") return "verify";
    if (stage === "deliver") return "deliver";
    return "plan";
  }
  if (record?.kind === "warning") return "coordinate";
  if (
    record?.actor === "subagent" &&
    ["review", "verify"].includes(record?.role)
  ) {
    return "verify";
  }
  if (record?.actor === "subagent") return "explore";

  const type = record?.eventType || "";
  if (["response.reset", "parallel_batch.started"].includes(type)) {
    return "thinking";
  }
  if (
    ["turn.started", "instructions.loaded", "context.compacted"].includes(
      type,
    )
  ) {
    return "understand";
  }
  if (["plan.updated", "memory.updated"].includes(type)) return "plan";
  if (type.startsWith("self_check.")) return "verify";
  if (
    ["approval.required", "control.paused", "control.resumed"].includes(type)
  ) {
    return "coordinate";
  }
  if (["turn.completed", "turn.cancelled", "turn.failed"].includes(type)) {
    return "deliver";
  }
  return "understand";
}

function legacyEntryBlockKind(entry) {
  if (entry.stage === "lens") return "explore";
  if (entry.stage === "forge") return "execute";
  if (entry.stage === "trial") return "verify";
  if (entry.stage === "deliver") return "deliver";
  return "plan";
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizedRoutePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function witnessBlockTitle(block, run, language) {
  const english = language === "en";
  const count = block.records.length;
  if (block.kind === "explore" && block.paths.length) {
    return english
      ? `Inspect ${block.paths.length} relevant location${block.paths.length === 1 ? "" : "s"}`
      : `定位并检查 ${block.paths.length} 个相关位置`;
  }
  if (block.kind === "plan" && block.planSteps.length) {
    return english
      ? `Shape ${block.planSteps.length} execution objective${block.planSteps.length === 1 ? "" : "s"}`
      : `整理 ${block.planSteps.length} 个执行目标`;
  }
  if (block.kind === "execute" && block.changes.length) {
    return english
      ? `Change ${block.changes.length} file${block.changes.length === 1 ? "" : "s"}`
      : `修改 ${block.changes.length} 个文件`;
  }
  if (block.kind === "execute") {
    return english
      ? `Complete ${count} creation or editing action${count === 1 ? "" : "s"}`
      : `完成 ${count} 项创建与修改`;
  }
  if (block.kind === "verify" && block.commands.length) {
    return english
      ? `Run ${block.commands.length} verification command${block.commands.length === 1 ? "" : "s"}`
      : `运行 ${block.commands.length} 项验证命令`;
  }
  if (block.kind === "verify") {
    return english
      ? `Review ${count} item${count === 1 ? "" : "s"} of evidence`
      : `复核 ${count} 项结果证据`;
  }
  if (block.kind === "deliver") {
    if (run?.status === "failed") {
      return english ? "Preserve completed work and report the failure" : "保留已完成工作并说明失败";
    }
    if (run?.status === "interrupted") {
      return english ? "Preserve the route before the run stopped" : "保留任务停止前的行动路径";
    }
    return english ? "Finish the run and prepare the result" : "完成任务并整理结果";
  }
  return english ? WITNESS_BLOCK_META[block.kind].en : WITNESS_BLOCK_META[block.kind].zh;
}

function witnessBlockSummary(block, language) {
  const english = language === "en";
  const pieces = [];
  if (block.paths.length) {
    pieces.push(
      english
        ? `${block.paths.length} file/location${block.paths.length === 1 ? "" : "s"}`
        : `${block.paths.length} 个文件或位置`,
    );
  }
  if (block.commands.length) {
    pieces.push(
      english
        ? `${block.commands.length} command${block.commands.length === 1 ? "" : "s"}`
        : `${block.commands.length} 条命令`,
    );
  }
  if (block.agents.length) {
    pieces.push(
      english
        ? `${block.agents.length} subagent${block.agents.length === 1 ? "" : "s"}`
        : `${block.agents.length} 个子 Agent`,
    );
  }
  if (block.changes.length) {
    pieces.push(
      english
        ? `${block.changes.length} changed file${block.changes.length === 1 ? "" : "s"}`
        : `${block.changes.length} 个修改文件`,
    );
  }
  if (!pieces.length) {
    pieces.push(
      english
        ? `${block.records.length} observable action${block.records.length === 1 ? "" : "s"}`
        : `${block.records.length} 条可观察行动`,
    );
  }
  return english ? pieces.join(" · ") : pieces.join(" · ");
}

export function buildWitnessRouteBlocks(run, language = "zh-CN") {
  if (!run) return [];
  const witnessRecords = Array.isArray(run.witness?.records)
    ? run.witness.records
    : [];
  const records = witnessRecords.length
    ? witnessRecords
    : (run.entries || []).map((entry, index) => ({
        ...entry,
        id: entry.id || `legacy-route-${index}`,
        kind: entry.tool ? "tool" : "status",
        eventType: "legacy.route",
        elapsedMs:
          entry.startedAt && entry.finishedAt
            ? Math.max(0, new Date(entry.finishedAt) - new Date(entry.startedAt))
            : 0,
        legacyEntry: entry,
      }));
  const blocks = [];

  for (const record of records) {
    let kind = witnessRecords.length
      ? witnessRecordBlockKind(record)
      : legacyEntryBlockKind(record);
    if (kind === "thinking") {
      const current = blocks.at(-1);
      if (current) {
        current.records.push(record);
        continue;
      }
      kind = "understand";
    }
    let block = blocks.at(-1);
    if (!block || block.kind !== kind) {
      block = {
        id: `witness-block-${blocks.length}-${record.id || kind}`,
        kind,
        label: WITNESS_BLOCK_META[kind]?.label || "Route",
        records: [],
        paths: [],
        commands: [],
        agents: [],
        changes: [],
        planSteps: [],
      };
      blocks.push(block);
    }
    block.records.push(record);
  }

  if (run.plan?.steps?.length) {
    let planBlock = blocks.find((block) => block.kind === "plan");
    if (!planBlock) {
      const firstActionIndex = blocks.findIndex((block) =>
        ["execute", "verify", "deliver"].includes(block.kind),
      );
      const insertionIndex =
        firstActionIndex >= 0 ? firstActionIndex : blocks.length;
      planBlock = {
        id: `witness-block-plan-${run.id || "run"}`,
        kind: "plan",
        label: WITNESS_BLOCK_META.plan.label,
        records: [],
        paths: [],
        commands: [],
        agents: [],
        changes: [],
        planSteps: [],
      };
      blocks.splice(insertionIndex, 0, planBlock);
    }
    planBlock.planSteps = run.plan.steps;
  }

  for (const block of blocks) {
    block.paths = uniqueNonEmpty(block.records.map((record) => record.path));
    block.commands = uniqueNonEmpty(
      block.records.map((record) => record.command),
    );
    block.agents = uniqueNonEmpty(
      block.records.map((record) => record.agentId),
    );
    block.changes = [];
  }

  for (const change of run.changes || []) {
    const normalizedChangePath = normalizedRoutePath(change.path);
    let executeBlock = [...blocks].reverse().find(
      (block) =>
        block.kind === "execute" &&
        block.paths.some(
          (path) => normalizedRoutePath(path) === normalizedChangePath,
        ),
    );
    executeBlock ||= [...blocks]
      .reverse()
      .find((block) => block.kind === "execute");
    if (!executeBlock) {
      executeBlock = {
        id: `witness-block-execute-${run.id || "run"}`,
        kind: "execute",
        label: WITNESS_BLOCK_META.execute.label,
        records: [],
        paths: [],
        commands: [],
        agents: [],
        changes: [],
        planSteps: [],
      };
      const deliveryIndex = blocks.findIndex((block) => block.kind === "deliver");
      blocks.splice(deliveryIndex >= 0 ? deliveryIndex : blocks.length, 0, executeBlock);
    }
    executeBlock.changes.push(change);
    executeBlock.paths = uniqueNonEmpty([
      ...executeBlock.paths,
      change.path,
    ]);
  }

  return blocks.map((block) => {
    const statuses = block.records.map((record) => record.status);
    const hasActive = statuses.some((status) =>
      ["running", "waiting"].includes(status),
    );
    const hasInterrupted = statuses.includes("interrupted");
    const failedCount = statuses.filter((status) => status === "failed").length;
    const status = hasActive
      ? "running"
      : hasInterrupted
        ? "interrupted"
        : failedCount
          ? "attention"
          : "completed";
    const additions = block.changes.reduce(
      (total, change) => total + (change.additions || 0),
      0,
    );
    const deletions = block.changes.reduce(
      (total, change) => total + (change.deletions || 0),
      0,
    );
    return {
      ...block,
      status,
      failedCount,
      additions,
      deletions,
      title: witnessBlockTitle(block, run, language),
      summary: witnessBlockSummary(block, language),
    };
  });
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
      planStepId: step.planStepId || entry.planStepId || null,
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
      planStepId: step.planStepId || null,
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

export function summarizeRoutePrompt(value, maximum = 32) {
  const clean = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[\s>*#\-+`\d.、:：]+/g, "")
    .replace(/[*_~`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";

  const firstSentence =
    clean.match(/^.*?[。！？.!?](?:\s|$)/)?.[0]?.trim() || clean;
  if (firstSentence.length <= maximum) return firstSentence;
  return `${firstSentence.slice(0, maximum).trimEnd()}…`;
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
      const prompt =
        sourceMessage?.content ||
        message.prompt ||
        `任务 ${index + 1}`;
      return {
        id: message.id,
        messageId: message.id,
        prompt,
        summary: summarizeRoutePrompt(prompt),
        createdAt: message.createdAt || sourceMessage?.createdAt || null,
        completedAt: message.completedAt || null,
        status: message.status || "completed",
        entries,
        changes: message.changes || [],
        selfCheck: message.selfCheck || null,
        plan: message.plan || null,
        witness: message.witness || null,
        contextCheckpoints: message.contextCheckpoints || [],
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
