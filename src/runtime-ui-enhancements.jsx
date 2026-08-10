import React from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Eye, ImagePlus } from "lucide-react";
import {
  formatTaskDuration,
  readTaskListFromStorage,
  resolveVisionCapability,
  selectVisibleTask,
} from "./runtime-ui-core.js";
import "./runtime-ui-enhancements.css";

const durationRoots = new Map();
let visionHost = null;
let visionRoot = null;
let authoritativeTasks = [];
let providers = [];
let tasksRefreshPromise = null;
let providerRefreshPromise = null;
let lastTaskRefresh = 0;
let lastProviderRefresh = 0;
let refreshQueued = false;

function isEnglish() {
  return String(document.documentElement.lang || "")
    .toLowerCase()
    .startsWith("en");
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
      {running && <span className="aporiax-run-duration-dot" aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}

function cleanupDurationHost(host) {
  const root = durationRoots.get(host);
  if (root) {
    try {
      root.unmount();
    } catch {
      // Presentation-only enhancement cleanup must not affect the task UI.
    }
    durationRoots.delete(host);
  }
  host.remove();
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
      if (host) cleanupDurationHost(host);
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
      cleanupDurationHost(host);
    }
  }
}

function capabilityStatusText(capability) {
  if (capability.mode === "native") {
    return tr("当前模型原生支持图片输入", "Current model supports images natively");
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
  const mainModel = capability.mainModelName || capability.mainModelId || tr("当前模型", "Current model");
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
            {nativeMode && (
              <em>{tr("原生视觉", "Native vision")}</em>
            )}
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

  if (!visionHost || !visionHost.isConnected || visionHost.parentElement !== panel) {
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

function refreshPresentation() {
  syncDurationChips();
  syncVisionCapability();
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
