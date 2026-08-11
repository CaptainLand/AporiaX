const TOOL_PRESENTATION = {
  delegate_subagent: ["lens", "委派子 Agent", "Delegate subagent", "正在委派子 Agent", "Delegating to a subagent", "agent"],
  collect_subagents: ["lens", "收集子 Agent 结果", "Collect subagent results", "正在收集子 Agent 结果", "Collecting subagent results", "agent"],
  remember_project_fact: ["route", "提交项目理解候选", "Propose Project Understanding", "正在提交项目理解候选", "Proposing Project Understanding", "memory"],
  update_plan: ["route", "更新执行计划", "Update execution plan", "正在更新执行计划", "Updating execution plan", "route"],
  list_directory: ["lens", "浏览工作区", "Browse workspace", "正在浏览工作区", "Browsing workspace", "folder"],
  read_file: ["lens", "读取文件", "Read file", "正在读取文件", "Reading file", "file-read"],
  search_text: ["lens", "定位相关内容", "Locate relevant content", "正在搜索代码", "Searching code", "search"],
  git_status: ["lens", "检查 Git 状态", "Inspect Git status", "正在检查 Git 状态", "Inspecting Git status", "git"],
  git_diff: ["lens", "检查代码差异", "Inspect code diff", "正在读取代码差异", "Reading code diff", "git"],
  write_file: ["forge", "写入文件", "Write file", "正在修改文件", "Writing file", "file-write"],
  apply_patch: ["forge", "修改代码", "Patch code", "正在精确修改代码", "Applying a precise code patch", "patch"],
  create_word_document: ["forge", "创建 Word 文档", "Create Word document", "正在生成 Word 文档", "Creating Word document", "document"],
  create_presentation: ["forge", "创建演示文稿", "Create presentation", "正在生成 PowerPoint", "Creating PowerPoint presentation", "presentation"],
  create_spreadsheet: ["forge", "创建电子表格", "Create spreadsheet", "正在生成 Excel 工作簿", "Creating Excel workbook", "spreadsheet"],
  inspect_office_file: ["trial", "检查 Office 文件", "Inspect Office file", "正在检查 Office 工件", "Inspecting Office artifact", "document-check"],
  run_command: ["trial", "运行验证命令", "Run verification command", "正在运行命令", "Running command", "terminal"],
  browser_open: ["lens", "打开浏览器页面", "Open browser page", "正在打开浏览器页面", "Opening browser page", "browser"],
  browser_snapshot: ["lens", "观察页面结构", "Inspect page structure", "正在观察页面结构", "Inspecting page structure", "browser-read"],
  browser_console: ["trial", "检查浏览器控制台", "Inspect browser console", "正在检查浏览器控制台", "Inspecting browser console", "browser-check"],
  browser_network: ["trial", "检查网络请求", "Inspect browser network", "正在检查网络请求", "Inspecting browser network", "network"],
  browser_screenshot: ["trial", "保存页面快照", "Capture page screenshot", "正在保存页面快照", "Capturing page screenshot", "camera"],
  browser_click: ["forge", "点击页面元素", "Click page element", "正在点击页面元素", "Clicking page element", "pointer"],
  browser_fill: ["forge", "填写页面内容", "Fill page input", "正在填写页面内容", "Filling page input", "keyboard"],
  browser_press: ["forge", "发送键盘操作", "Send keyboard input", "正在发送键盘操作", "Sending keyboard input", "keyboard"],
  browser_close: ["route", "关闭浏览器会话", "Close browser session", "正在关闭浏览器会话", "Closing browser session", "browser"],
  request_self_check: ["trial", "请求独立自检", "Request independent review", "正在启动自适应自检", "Starting adaptive self-check", "verify"],
  complete_self_check: ["trial", "提交自检结果", "Submit self-check result", "正在提交自检报告", "Submitting self-check report", "verify"],
};

function normalize(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

export function stageForCapability({ risk = "none", source = "runtime" } = {}) {
  if (risk === "read") return "lens";
  if (risk === "write") return "forge";
  if (risk === "execute") return "trial";
  if (source === "mcp" && risk === "control") return "forge";
  return "route";
}

export function defaultCapabilityPresentation({
  name = "",
  title = "",
  source = "runtime",
  risk = "none",
} = {}) {
  const known = TOOL_PRESENTATION[name];
  if (known) {
    return {
      stage: known[0],
      titleZh: known[1],
      titleEn: known[2],
      activityZh: known[3],
      activityEn: known[4],
      iconKey: known[5],
    };
  }
  const display = normalize(title || name || "Capability", 180);
  const sourceLabel = source === "mcp" ? "MCP" : source === "plugin" ? "Plugin" : "AporiaX";
  return {
    stage: stageForCapability({ risk, source }),
    titleZh: display,
    titleEn: display,
    activityZh: source === "mcp" ? `正在调用 MCP · ${display}` : `正在执行 ${display}`,
    activityEn: source === "mcp" ? `Calling MCP · ${display}` : `Running ${display}`,
    iconKey: source === "mcp" ? "mcp" : source === "plugin" ? "plugin" : sourceLabel.toLowerCase(),
  };
}

export function normalizeCapabilityPresentation(input, fallback = {}) {
  const base = defaultCapabilityPresentation(fallback);
  const stage = normalize(input?.stage || base.stage, 32).toLowerCase();
  return Object.freeze({
    stage: ["lens", "route", "forge", "trial", "deliver"].includes(stage) ? stage : base.stage,
    titleZh: normalize(input?.titleZh || base.titleZh, 180),
    titleEn: normalize(input?.titleEn || base.titleEn, 180),
    activityZh: normalize(input?.activityZh || base.activityZh, 240),
    activityEn: normalize(input?.activityEn || base.activityEn, 240),
    iconKey: normalize(input?.iconKey || base.iconKey, 80),
  });
}

export function publicToolCapability(capability, phase = "work") {
  if (!capability) return null;
  const presentation = normalizeCapabilityPresentation(capability.presentation, capability);
  return Object.freeze({
    id: capability.id,
    kind: capability.kind,
    source: capability.source,
    name: capability.name,
    title: capability.title,
    risk: capability.risk,
    serverId: capability.serverId || null,
    plugin: capability.plugin || null,
    stage:
      phase === "self-check" && presentation.stage !== "forge"
        ? "trial"
        : presentation.stage,
    titleZh: presentation.titleZh,
    titleEn: presentation.titleEn,
    activityZh: presentation.activityZh,
    activityEn: presentation.activityEn,
    iconKey: presentation.iconKey,
  });
}
