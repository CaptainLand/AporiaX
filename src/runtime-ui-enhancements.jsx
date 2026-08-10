import React from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  Eye,
  FileText,
  ImagePlus,
  LoaderCircle,
  Terminal,
} from "lucide-react";
import {
  buildAgentProcessSummary,
  currentProcessSummary,
  extractWorkspaceMentionQuery,
  rankWorkspaceFiles,
  replaceWorkspaceMentionQuery,
} from "./agent-process-model.js";
import {
  formatTaskDuration,
  readTaskListFromStorage,
  resolveVisionCapability,
  selectVisibleTask,
} from "./runtime-ui-core.js";
import "./runtime-ui-enhancements.css";

const durationRoots = new Map();
const processRoots = new Map();
const workspaceFileIndexes = new Map();
let visionHost = null;
let visionRoot = null;
let mentionHost = null;
let mentionRoot = null;
let mentionTextarea = null;
let authoritativeTasks = [];
let providers = [];
let tasksRefreshPromise = null;
let providerRefreshPromise = null;
let lastTaskRefresh = 0;
let lastProviderRefresh = 0;
let refreshQueued = false;
let mentionState = {
  query: null,
  workspacePath: "",
  suggestions: [],
  selectedIndex: 0,
  loading: false,
};

function isEnglish() {
  return String(document.documentElement.lang || "")
    .toLowerCase()
    .startsWith("en");
}

function languageCode() {
  return isEnglish() ? "en" : "zh-CN";
}

function tr(zh, en) {
  return isEnglish() ? en : zh;
}

function visibleTaskDescriptor() {
  return {
    title:
      document
        .querySelector(".thread-heading-copy h1")
        ?.textContent?.trim() || "",
    workspace:
      document
        .querySelector(".thread-heading-copy span")
        ?.textContent?.trim() || "",
    assistantCount: document.querySelectorAll(
      ".message-list .assistant-message",
    ).length,
  };
}

function currentVisibleTask() {
  const descriptor = visibleTaskDescriptor();
  const localTasks = readTaskListFromStorage(window.localStorage);
  return (
    selectVisibleTask(localTasks, descriptor) ||
    selectVisibleTask(authoritativeTasks, descriptor) ||
    null
  );
}

async function refreshTasksFromDesktop({ force = false } = {}) {
  if (!window.desktop?.tasks?.load) return;
  const now = Date.now();
  if (!force && now - lastTaskRefresh < 4_000) return;
  if (tasksRefreshPromise) return tasksRefreshPromise;
  lastTaskRefresh = now;
  tasksRefreshPromise = Promise.resolve(window.desktop.tasks.load())
    .then((records) => {
      authoritativeTasks = Array.isArray(records) ? records : [];
    })
    .catch(() => undefined)
    .finally(() => {
      tasksRefreshPromise = null;
    });
  return tasksRefreshPromise;
}

async function refreshProvidersFromDesktop({ force = false } = {}) {
  if (!window.desktop?.providers?.list) return;
  const now = Date.now();
  if (!force && now - lastProviderRefresh < 4_000) return;
  if (providerRefreshPromise) return providerRefreshPromise;
  lastProviderRefresh = now;
  providerRefreshPromise = Promise.resolve(window.desktop.providers.list())
    .then((records) => {
      providers = Array.isArray(records) ? records : [];
    })
    .catch(() => undefined)
    .finally(() => {
      providerRefreshPromise = null;
    });
  return providerRefreshPromise;
}

function RunDurationChip({ message, now }) {
  const startedAt = Date.parse(
    message?.createdAt || message?.anchor?.startedAt || "",
  );
  const completedAt = Date.parse(
    message?.completedAt || message?.anchor?.completedAt || "",
  );
  if (!Number.isFinite(startedAt)) return null;

  const running =
    message?.status === "running" && !Number.isFinite(completedAt);
  if (!running && !Number.isFinite(completedAt)) return null;

  const end = running ? now : completedAt;
  const label = formatTaskDuration(Math.max(0, end - startedAt));
  return (
    <span
      className={`aporiax-run-duration ${running ? "running" : ""}`}
      title={tr(
        `本次任务运行时间 · ${label}`,
        `Task elapsed time · ${label}`,
      )}
    >
      {running && (
        <span className="aporiax-run-duration-dot" aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
}

function cleanupRoot(map, host) {
  const root = map.get(host);
  if (root) {
    try {
      root.unmount();
    } catch {
      // Presentation-only enhancement cleanup must not affect the task UI.
    }
    map.delete(host);
  }
  host?.remove();
}

function syncDurationChips() {
  const task = currentVisibleTask();
  const headings = [
    ...document.querySelectorAll(
      ".message-list .assistant-message .assistant-message-heading",
    ),
  ];
  const messages = (Array.isArray(task?.messages) ? task.messages : []).filter(
    (message) => message?.role === "assistant",
  );
  const activeHosts = new Set();
  const now = Date.now();

  headings.forEach((heading, index) => {
    const message = messages[index];
    let host = heading.querySelector(
      ":scope > .aporiax-run-duration-host",
    );
    if (!message) {
      if (host) cleanupRoot(durationRoots, host);
      return;
    }
    if (!host) {
      host = document.createElement("span");
      host.className = "aporiax-run-duration-host";
      heading.appendChild(host);
    }
    activeHosts.add(host);
    let root = durationRoots.get(host);
    if (!root) {
      root = createRoot(host);
      durationRoots.set(host, root);
    }
    root.render(<RunDurationChip message={message} now={now} />);
  });

  for (const host of [...durationRoots.keys()]) {
    if (!host.isConnected || !activeHosts.has(host)) {
      cleanupRoot(durationRoots, host);
    }
  }
}

function ProcessStepIcon({ status }) {
  if (status === "running") {
    return <LoaderCircle className="spin" size={13} />;
  }
  return <Check size={13} />;
}

function AgentProcessTrace({ message }) {
  const steps = buildAgentProcessSummary(message, languageCode());
  if (!steps.length) return null;
  const current = currentProcessSummary(steps);
  const running = message?.status === "running";

  return (
    <section className={`aporiax-agent-process ${running ? "running" : "done"}`}>
      <div className="aporiax-agent-process-heading">
        <span className="aporiax-agent-process-mark">
          {running ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Check size={14} />
          )}
        </span>
        <div>
          <strong>{tr("Agent 过程", "Agent process")}</strong>
          <span>
            {current?.title ||
              tr("正在整理执行过程", "Preparing the execution trace")}
          </span>
        </div>
        <em>
          {running ? tr("进行中", "Live") : tr("已保留", "Saved")}
        </em>
      </div>
      <p className="aporiax-agent-process-note">
        {tr(
          "展示可观察的行动与过程摘要，不显示模型私有思维链。任务结束后仍会保留。",
          "Shows observable actions and concise process summaries, not private chain-of-thought. The trace remains after completion.",
        )}
      </p>
      <div className="aporiax-agent-process-steps">
        {steps.map((step) => (
          <details
            className={`aporiax-agent-process-step ${step.status}`}
            key={step.id}
            open={step.status === "running" ? true : undefined}
          >
            <summary>
              <span className="aporiax-agent-process-step-icon">
                <ProcessStepIcon status={step.status} />
              </span>
              <span className="aporiax-agent-process-step-copy">
                <strong>{step.title}</strong>
                <small>{step.summary}</small>
              </span>
              <span className="aporiax-agent-process-step-state">
                {step.status === "running"
                  ? tr("正在做", "Working")
                  : step.status === "attention"
                    ? tr("需注意", "Attention")
                    : step.status === "interrupted"
                      ? tr("已停止", "Stopped")
                      : tr("完成", "Done")}
              </span>
            </summary>
            {(step.paths.length > 0 ||
              step.commands.length > 0 ||
              step.planSteps.length > 0) && (
              <div className="aporiax-agent-process-detail">
                {step.planSteps.map((planStep) => (
                  <div className="aporiax-agent-process-plan" key={planStep.id}>
                    <span>{planStep.status === "completed" ? "✓" : "·"}</span>
                    <div>
                      <strong>{planStep.title}</strong>
                      {planStep.detail && <small>{planStep.detail}</small>}
                    </div>
                  </div>
                ))}
                {step.paths.map((path) => (
                  <code key={`path-${path}`}>
                    <FileText size={11} />
                    {path}
                  </code>
                ))}
                {step.commands.map((command) => (
                  <code key={`command-${command}`}>
                    <Terminal size={11} />
                    {command}
                  </code>
                ))}
              </div>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}

function syncProcessTraces() {
  const task = currentVisibleTask();
  const articles = [
    ...document.querySelectorAll(".message-list .assistant-message"),
  ];
  const messages = (Array.isArray(task?.messages) ? task.messages : []).filter(
    (message) => message?.role === "assistant",
  );
  const activeHosts = new Set();

  articles.forEach((article, index) => {
    const message = messages[index];
    const content = article.querySelector(":scope > .assistant-message-content");
    let host = article.querySelector(":scope > .aporiax-agent-process-host");
    if (!message || !content) {
      if (host) cleanupRoot(processRoots, host);
      return;
    }
    const steps = buildAgentProcessSummary(message, languageCode());
    if (!steps.length) {
      if (host) cleanupRoot(processRoots, host);
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.className = "aporiax-agent-process-host";
      content.insertAdjacentElement("afterend", host);
    }
    activeHosts.add(host);
    let root = processRoots.get(host);
    if (!root) {
      root = createRoot(host);
      processRoots.set(host, root);
    }
    root.render(<AgentProcessTrace message={message} />);
  });

  for (const host of [...processRoots.keys()]) {
    if (!host.isConnected || !activeHosts.has(host)) {
      cleanupRoot(processRoots, host);
    }
  }
}

function capabilityStatusText(capability) {
  if (capability.mode === "native") {
    return tr(
      "当前模型原生支持图片输入",
      "Current model supports images natively",
    );
  }
  if (capability.mode === "proxy") {
    const proxyName = capability.proxy?.modelName || capability.proxy?.modelId;
    return tr(
      `通过 ${proxyName} 自动识图`,
      `Images are automatically routed through ${proxyName}`,
    );
  }
  return tr(
    "当前主模型不支持图片，且尚未配置视觉模型",
    "The current main model is text-only and no vision model is configured",
  );
}

function VisionCapabilityCard({ capability }) {
  const available = capability.available;
  const proxyMode = capability.mode === "proxy";
  const nativeMode = capability.mode === "native";
  const mainModel =
    capability.mainModelName ||
    capability.mainModelId ||
    tr("当前模型", "Current model");
  const proxyModel =
    capability.proxy?.modelName || capability.proxy?.modelId || "";

  const manageModels = () => {
    const manageButton = document.querySelector(
      ".settings-panel .settings-section .settings-link",
    );
    if (manageButton instanceof HTMLElement) {
      manageButton.click();
      window.setTimeout(
        () => void refreshProvidersFromDesktop({ force: true }),
        1_000,
      );
    }
  };

  return (
    <section
      className={`aporiax-vision-capability ${
        available ? "ready" : "missing"
      }`}
    >
      <div className="aporiax-vision-label">
        {tr("视觉能力", "Vision capability")}
      </div>
      <div className="aporiax-vision-card">
        <div className="aporiax-vision-heading">
          <span className="aporiax-vision-icon">
            {available ? <Eye size={16} /> : <ImagePlus size={16} />}
          </span>
          <div>
            <strong>
              {available
                ? tr("图片识别已启用", "Image recognition enabled")
                : tr("未启用图片识别", "Image recognition unavailable")}
            </strong>
            <span>{capabilityStatusText(capability)}</span>
          </div>
        </div>

        {(nativeMode || proxyMode) && (
          <div className="aporiax-vision-route">
            <div>
              <span>{tr("主模型", "Main model")}</span>
              <strong>{mainModel}</strong>
            </div>
            {proxyMode && (
              <>
                <ArrowRight size={13} aria-hidden="true" />
                <div>
                  <span>{tr("视觉代理", "Vision proxy")}</span>
                  <strong>{proxyModel}</strong>
                </div>
              </>
            )}
            {nativeMode && <em>{tr("原生视觉", "Native vision")}</em>}
          </div>
        )}

        <p>
          {nativeMode
            ? tr(
                "图片会直接交给当前主模型处理，不需要额外视觉代理。",
                "Images go directly to the current main model; no extra vision proxy is needed.",
              )
            : proxyMode
              ? tr(
                  `上传图片时，AporiaX 会先调用 ${proxyModel} 解析，再把结果自动交给 ${mainModel} 继续思考与执行。`,
                  `When you attach an image, AporiaX asks ${proxyModel} to inspect it first, then passes the observation to ${mainModel} for reasoning and execution.`,
                )
              : tr(
                  "添加一个视觉模型后，AporiaX 会自动将它用于 DeepSeek 等非图像模型的识图，无需切换主思考模型。",
                  "Add a vision model and AporiaX will automatically use it for text-only models such as DeepSeek, without changing your main reasoning model.",
                )}
        </p>

        {!available && (
          <div className="aporiax-vision-recommendation">
            <span>{tr("推荐", "Recommended")}</span>
            <strong>Qwen3.5-Flash</strong>
          </div>
        )}

        <button type="button" onClick={manageModels}>
          {available
            ? tr("管理视觉模型", "Manage vision models")
            : tr("去添加视觉模型", "Add a vision model")}
          <ArrowRight size={13} />
        </button>
      </div>
    </section>
  );
}

function cleanupVisionRoot() {
  if (visionRoot) {
    try {
      visionRoot.unmount();
    } catch {
      // Presentation-only enhancement cleanup must not affect settings.
    }
  }
  visionRoot = null;
  visionHost?.remove();
  visionHost = null;
}

function syncVisionCapability() {
  const panel = document.querySelector(".settings-panel");
  if (!panel) {
    if (visionHost && !visionHost.isConnected) cleanupVisionRoot();
    return;
  }

  if (
    !visionHost ||
    !visionHost.isConnected ||
    visionHost.parentElement !== panel
  ) {
    cleanupVisionRoot();
    visionHost = document.createElement("div");
    visionHost.className = "aporiax-vision-capability-host";
    panel.appendChild(visionHost);
    visionRoot = createRoot(visionHost);
  }

  const task = currentVisibleTask();
  if (!task || !visionRoot) return;
  const capability = resolveVisionCapability(providers, task);
  visionRoot.render(<VisionCapabilityCard capability={capability} />);
}

async function buildWorkspaceFileIndex(workspacePath) {
  if (!workspacePath || !window.desktop?.workspace?.listTree) return [];
  if (workspaceFileIndexes.has(workspacePath)) {
    return workspaceFileIndexes.get(workspacePath);
  }

  const promise = (async () => {
    const files = [];
    const queue = ["."];
    const visited = new Set();
    while (queue.length && visited.size < 260 && files.length < 4_000) {
      const directory = queue.shift();
      if (!directory || visited.has(directory)) continue;
      visited.add(directory);
      let result;
      try {
        result = await window.desktop.workspace.listTree(
          workspacePath,
          directory,
        );
      } catch {
        continue;
      }
      for (const entry of result?.entries || []) {
        if (entry?.type === "file") {
          files.push(String(entry.path || "").replace(/\\/g, "/"));
          if (files.length >= 4_000) break;
        } else if (entry?.type === "directory" && entry.path) {
          queue.push(entry.path);
        }
      }
    }
    return [...new Set(files)].filter(Boolean);
  })();

  workspaceFileIndexes.set(workspacePath, promise);
  return promise;
}

function WorkspaceMentionMenu({ state, onSelect }) {
  return (
    <div className="aporiax-workspace-mention-menu" role="listbox">
      <div className="aporiax-workspace-mention-title">
        <span>
          <FileText size={13} />
          {tr("引用工作区文件", "Mention workspace file")}
        </span>
        <small>{tr("@ 文件会作为本轮上下文", "@ files become turn context")}</small>
      </div>
      {state.loading ? (
        <div className="aporiax-workspace-mention-empty">
          <LoaderCircle className="spin" size={13} />
          {tr("正在索引工作区…", "Indexing workspace…")}
        </div>
      ) : state.suggestions.length ? (
        <div className="aporiax-workspace-mention-results">
          {state.suggestions.map((path, index) => (
            <button
              className={index === state.selectedIndex ? "active" : ""}
              key={path}
              type="button"
              role="option"
              aria-selected={index === state.selectedIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(path)}
            >
              <FileText size={13} />
              <span>{path}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="aporiax-workspace-mention-empty">
          {tr("没有匹配的文件", "No matching files")}
        </div>
      )}
      <div className="aporiax-workspace-mention-footer">
        <span>↑↓ {tr("选择", "Select")}</span>
        <span>Enter / Tab {tr("引用", "Mention")}</span>
        <span>Esc {tr("关闭", "Close")}</span>
      </div>
    </div>
  );
}

function cleanupMentionMenu() {
  mentionState = {
    query: null,
    workspacePath: "",
    suggestions: [],
    selectedIndex: 0,
    loading: false,
  };
  if (mentionRoot) {
    try {
      mentionRoot.unmount();
    } catch {
      // Autocomplete cleanup is presentation-only.
    }
  }
  mentionRoot = null;
  mentionHost?.remove();
  mentionHost = null;
}

function renderMentionMenu() {
  if (!mentionState.query || !mentionTextarea?.isConnected) {
    cleanupMentionMenu();
    return;
  }
  const composer = mentionTextarea.closest(".composer");
  if (!composer) {
    cleanupMentionMenu();
    return;
  }
  if (!mentionHost || !mentionHost.isConnected) {
    mentionHost = document.createElement("div");
    mentionHost.className = "aporiax-workspace-mention-host";
    composer.appendChild(mentionHost);
    mentionRoot = createRoot(mentionHost);
  }
  mentionRoot.render(
    <WorkspaceMentionMenu state={mentionState} onSelect={selectWorkspaceMention} />,
  );
}

function setControlledTextareaValue(textarea, value, cursor) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  window.requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
  });
}

function selectWorkspaceMention(path) {
  if (!mentionTextarea || !mentionState.query) return;
  const result = replaceWorkspaceMentionQuery(
    mentionTextarea.value,
    mentionState.query,
    path,
  );
  setControlledTextareaValue(mentionTextarea, result.value, result.cursor);
  cleanupMentionMenu();
}

async function refreshMentionState() {
  if (!mentionTextarea?.isConnected) return cleanupMentionMenu();
  const query = extractWorkspaceMentionQuery(
    mentionTextarea.value,
    mentionTextarea.selectionStart,
  );
  const workspacePath = currentVisibleTask()?.workspacePath || "";
  if (!query || !workspacePath) return cleanupMentionMenu();

  mentionState = {
    query,
    workspacePath,
    suggestions: mentionState.suggestions,
    selectedIndex: 0,
    loading: true,
  };
  renderMentionMenu();

  const paths = await buildWorkspaceFileIndex(workspacePath);
  if (!mentionTextarea?.isConnected) return;
  const latestQuery = extractWorkspaceMentionQuery(
    mentionTextarea.value,
    mentionTextarea.selectionStart,
  );
  if (
    !latestQuery ||
    latestQuery.start !== query.start ||
    latestQuery.query !== query.query
  ) {
    return;
  }
  mentionState = {
    query: latestQuery,
    workspacePath,
    suggestions: rankWorkspaceFiles(paths, latestQuery.query, 12),
    selectedIndex: 0,
    loading: false,
  };
  renderMentionMenu();
}

function handleMentionKeyDown(event) {
  if (!mentionState.query || !mentionRoot) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cleanupMentionMenu();
    return;
  }
  if (!mentionState.suggestions.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const count = mentionState.suggestions.length;
    mentionState = {
      ...mentionState,
      selectedIndex:
        (mentionState.selectedIndex + direction + count) % count,
    };
    renderMentionMenu();
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    selectWorkspaceMention(
      mentionState.suggestions[mentionState.selectedIndex] ||
        mentionState.suggestions[0],
    );
  }
}

function syncComposerMentionBinding() {
  const textarea = document.querySelector(
    ".composer textarea:not(.provider-models-input)",
  );
  if (textarea === mentionTextarea) return;
  if (mentionTextarea) {
    mentionTextarea.removeEventListener("input", refreshMentionState);
    mentionTextarea.removeEventListener("click", refreshMentionState);
    mentionTextarea.removeEventListener("keyup", refreshMentionState);
    mentionTextarea.removeEventListener("keydown", handleMentionKeyDown);
  }
  cleanupMentionMenu();
  mentionTextarea = textarea instanceof HTMLTextAreaElement ? textarea : null;
  if (!mentionTextarea) return;
  mentionTextarea.addEventListener("input", refreshMentionState);
  mentionTextarea.addEventListener("click", refreshMentionState);
  mentionTextarea.addEventListener("keyup", refreshMentionState);
  mentionTextarea.addEventListener("keydown", handleMentionKeyDown);
}

function refreshPresentation() {
  syncDurationChips();
  syncProcessTraces();
  syncVisionCapability();
  syncComposerMentionBinding();
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  window.requestAnimationFrame(() => {
    refreshQueued = false;
    refreshPresentation();
  });
}

const observer = new MutationObserver(scheduleRefresh);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.setInterval(() => {
  void refreshTasksFromDesktop();
  if (document.querySelector(".settings-panel")) {
    void refreshProvidersFromDesktop();
  }
  refreshPresentation();
}, 1_000);

void Promise.all([
  refreshTasksFromDesktop({ force: true }),
  refreshProvidersFromDesktop({ force: true }),
]).finally(refreshPresentation);
