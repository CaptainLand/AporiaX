import { buildWitnessRouteBlocks } from "./p0-model.js";

function normalizedLanguage(language) {
  return String(language || "").toLowerCase().startsWith("en")
    ? "en"
    : "zh-CN";
}

function compactValues(values, limit) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

const GENERIC_PLAN_STEP = /^(?:理解|分析|检查|整理|完成|开始|准备|处理|确认|review|inspect|analy[sz]e|understand|prepare|finish|complete|handle)(?:任务|需求|结果|上下文|代码|项目|the task|the request|the result|context|code|project)?$/iu;

function isSpecificPlanStep(step) {
  const title = String(step?.title || "").trim();
  if (!title || title.length < 4) return false;
  return !GENERIC_PLAN_STEP.test(title);
}

function hasToolRecord(block, excluded = new Set()) {
  return (block?.records || []).some(
    (record) => record?.tool && !excluded.has(record.tool),
  );
}

function isMeaningfulProcessBlock(block) {
  if (!block) return false;

  // Context bootstrap and delivery bookkeeping are useful to Witness, but they
  // do not tell a user what work the Agent actually performed. Keep them out of
  // the compact process UI entirely.
  if (["understand", "deliver"].includes(block.kind)) return false;

  if (block.kind === "plan") {
    return (block.planSteps || []).some(isSpecificPlanStep);
  }

  if (block.kind === "explore") {
    return Boolean(
      block.paths?.length ||
        block.agents?.length ||
        hasToolRecord(block),
    );
  }

  if (block.kind === "execute") {
    return Boolean(
      block.paths?.length ||
        block.changes?.length ||
        hasToolRecord(block),
    );
  }

  if (block.kind === "verify") {
    return Boolean(
      block.commands?.length ||
        block.agents?.length ||
        hasToolRecord(block, new Set(["complete_self_check"])),
    );
  }

  if (block.kind === "coordinate") {
    return ["running", "attention", "interrupted"].includes(block.status);
  }

  return false;
}

function userFacingBlockTitle(block, language) {
  const english = normalizedLanguage(language) === "en";
  if (block.kind === "plan") {
    const active = (block.planSteps || []).find(
      (step) => step.status === "in_progress" && isSpecificPlanStep(step),
    );
    const first = active || (block.planSteps || []).find(isSpecificPlanStep);
    if (first) return first.title;
  }
  if (block.kind === "explore" && block.paths?.length === 1) {
    return english
      ? `Inspect ${block.paths[0]}`
      : `检查 ${block.paths[0]}`;
  }
  if (block.kind === "verify" && block.commands?.length === 1) {
    return english ? "Run verification" : "运行验证";
  }
  return block.title;
}

export function buildAgentProcessSummary(message = {}, language = "zh-CN") {
  const lang = normalizedLanguage(language);
  const run = {
    id: message.id || "assistant-run",
    status: message.status || "completed",
    witness: message.witness || null,
    entries: Array.isArray(message.route) ? message.route : [],
    changes: Array.isArray(message.changes) ? message.changes : [],
    plan: message.plan || null,
  };
  return buildWitnessRouteBlocks(run, lang)
    .filter(isMeaningfulProcessBlock)
    .map((block) => ({
      id: block.id,
      kind: block.kind,
      status: block.status,
      title: userFacingBlockTitle(block, lang),
      summary: block.summary,
      paths: compactValues(block.paths, 4),
      commands: compactValues(block.commands, 2),
      agents: compactValues(block.agents, 3),
      planSteps: (block.planSteps || [])
        .filter(isSpecificPlanStep)
        .slice(0, 5)
        .map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
          detail: step.detail || "",
        })),
      recordCount: block.records?.length || 0,
    }));
}

export function currentProcessSummary(steps = []) {
  const active = (steps || []).find((step) => step.status === "running");
  return active || (steps || []).at(-1) || null;
}

export function deriveLiveAgentStatus(message = {}, language = "zh-CN") {
  const english = normalizedLanguage(language) === "en";
  const steps = buildAgentProcessSummary(message, language);
  const running = message?.status === "running";
  const failed = message?.status === "failed" || Boolean(message?.error);
  const interrupted = message?.status === "interrupted";
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  const activeStep = steps.find((step) => step.status === "running") || null;
  const current = activeStep || steps.at(-1) || null;
  const route = Array.isArray(message?.route) ? message.route : [];
  const activeRoute = [...route].reverse().find((entry) =>
    ["running", "waiting"].includes(entry?.status),
  );
  const currentPlanStep = (message?.plan?.steps || []).find(
    (step) => step?.status === "in_progress",
  );

  const title = running
    ? activeRoute?.title || currentPlanStep?.title || current?.title ||
      (english ? "Working on the task" : "正在处理任务")
    : failed
      ? english ? "Run failed" : "任务执行失败"
      : interrupted
        ? english ? "Run stopped" : "任务已停止"
        : english ? "Run completed" : "任务已完成";

  const detail = running
    ? activeRoute?.path || activeRoute?.command || activeRoute?.detail ||
      currentPlanStep?.detail || current?.summary ||
      (english ? "Waiting for the next observable action" : "等待下一项可观察操作")
    : current?.summary || "";

  const changeCount = Array.isArray(message?.changes)
    ? message.changes.filter((change) => !change?.reverted).length
    : 0;

  return {
    state: running ? "running" : failed ? "failed" : interrupted ? "interrupted" : "completed",
    title,
    detail,
    completedSteps,
    totalSteps: steps.length,
    changeCount,
    activeKind: activeStep?.kind || current?.kind || "understand",
  };
}

export function extractWorkspaceMentionQuery(text, cursor) {
  const source = String(text || "");
  const caret = Number.isInteger(cursor)
    ? Math.max(0, Math.min(source.length, cursor))
    : source.length;
  const before = source.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@{}"]*)$/u);
  if (!match) return null;
  const prefixLength = match[1]?.length || 0;
  const start = caret - match[0].length + prefixLength;
  return {
    start,
    end: caret,
    query: match[2] || "",
  };
}

export function formatWorkspaceMentionToken(path) {
  const normalized = String(path || "")
    .trim()
    .replace(/\\/g, "/");
  if (!normalized) return "@";
  if (/^(?:skill|mcp):[a-z][a-z0-9_-]{1,63}$/u.test(normalized)) {
    return `@${normalized}`;
  }
  return /^[A-Za-z0-9_.\-/]+$/u.test(normalized)
    ? `@${normalized}`
    : `@{${normalized}}`;
}

export function replaceWorkspaceMentionQuery(text, query, path) {
  const source = String(text || "");
  if (!query || query.start < 0 || query.end < query.start) {
    return { value: source, cursor: source.length };
  }
  const token = `${formatWorkspaceMentionToken(path)} `;
  const value = `${source.slice(0, query.start)}${token}${source.slice(query.end)}`;
  return {
    value,
    cursor: query.start + token.length,
  };
}

function fileScore(path, query) {
  const normalizedPath = String(path || "").toLowerCase();
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return 10;
  const name = normalizedPath.split("/").at(-1) || normalizedPath;
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  if (normalizedPath.startsWith(normalizedQuery)) return 2;
  if (name.includes(normalizedQuery)) return 3;
  if (normalizedPath.includes(normalizedQuery)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function rankWorkspaceFiles(paths, query, limit = 12) {
  return [...new Set((paths || []).map((path) => String(path || "").replace(/\\/g, "/")).filter(Boolean))]
    .map((path) => ({ path, score: fileScore(path, query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, limit))
    .map((item) => item.path);
}

const DISPLAY_MENTION_PATTERN = /(^|[\s（(【[])(@(?:(?:skill|mcp):[a-z][a-z0-9_-]{1,63}|\{[^}\r\n]{1,260}\}|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./@()-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,12}))(?=$|[\s,，。!?！？;；:：)）\]】])/giu;

export function tokenizeDisplayMentions(content) {
  const source = String(content || "");
  const parts = [];
  let cursor = 0;

  for (const match of source.matchAll(DISPLAY_MENTION_PATTERN)) {
    const boundary = match[1] || "";
    const token = match[2] || "";
    const tokenStart = (match.index || 0) + boundary.length;
    if (tokenStart > cursor) {
      parts.push({ type: "text", value: source.slice(cursor, tokenStart) });
    }
    const kind = token.toLowerCase().startsWith("@skill:")
      ? "skill"
      : token.toLowerCase().startsWith("@mcp:")
        ? "mcp"
        : "file";
    parts.push({ type: "mention", kind, value: token });
    cursor = tokenStart + token.length;
  }

  if (cursor < source.length) {
    parts.push({ type: "text", value: source.slice(cursor) });
  }
  return parts.length ? parts : [{ type: "text", value: source }];
}
