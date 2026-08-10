import React from "react";
import { createRoot } from "react-dom/client";
import { Check, CircleStop, LoaderCircle, TriangleAlert } from "lucide-react";
import { deriveLiveAgentStatus } from "./agent-process-model.js";
import {
  readTaskListFromStorage,
  selectVisibleTask,
} from "./runtime-ui-core.js";
import "./live-agent-status.css";

const roots = new Map();
let authoritativeTasks = [];
let refreshPromise = null;
let lastDesktopRefresh = 0;
let queued = false;

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

async function refreshAuthoritativeTasks({ force = false } = {}) {
  if (!window.desktop?.tasks?.load) return;
  const now = Date.now();
  if (!force && now - lastDesktopRefresh < 1_500) return;
  if (refreshPromise) return refreshPromise;
  lastDesktopRefresh = now;
  refreshPromise = Promise.resolve(window.desktop.tasks.load())
    .then((tasks) => {
      authoritativeTasks = Array.isArray(tasks) ? tasks : [];
    })
    .catch(() => undefined)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

function StatusIcon({ state }) {
  if (state === "running") {
    return <LoaderCircle className="spin" size={14} />;
  }
  if (state === "failed") return <TriangleAlert size={14} />;
  if (state === "interrupted") return <CircleStop size={14} />;
  return <Check size={14} />;
}

function LiveAgentStatus({ message }) {
  const status = deriveLiveAgentStatus(
    message,
    isEnglish() ? "en" : "zh-CN",
  );
  const progress = status.totalSteps
    ? `${status.completedSteps}/${status.totalSteps}`
    : "";

  return (
    <section
      className={`aporiax-live-agent-status ${status.state}`}
      aria-live={status.state === "running" ? "polite" : "off"}
    >
      <span className="aporiax-live-agent-status-icon" aria-hidden="true">
        <StatusIcon state={status.state} />
      </span>
      <div className="aporiax-live-agent-status-copy">
        <strong>{status.title}</strong>
        <span title={status.detail}>{status.detail}</span>
      </div>
      <div className="aporiax-live-agent-status-meta">
        {status.state === "running" ? (
          <em>{tr("进行中", "Live")}</em>
        ) : (
          <em>{tr("已保留", "Saved")}</em>
        )}
        {progress && <small>{progress}</small>}
        {status.changeCount > 0 && (
          <small>
            {tr(
              `${status.changeCount} 文件`,
              `${status.changeCount} file${status.changeCount === 1 ? "" : "s"}`,
            )}
          </small>
        )}
      </div>
    </section>
  );
}

function cleanupHost(host) {
  const root = roots.get(host);
  if (root) {
    try {
      root.unmount();
    } catch {
      // Live-status presentation must never interfere with the task UI.
    }
    roots.delete(host);
  }
  host?.remove();
}

function syncLiveStatuses() {
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
    const heading = article.querySelector(":scope > .assistant-message-heading");
    const content = article.querySelector(":scope > .assistant-message-content");
    let host = article.querySelector(":scope > .aporiax-live-agent-status-host");
    if (!message || !heading || !content) {
      if (host) cleanupHost(host);
      return;
    }

    if (!host) {
      host = document.createElement("div");
      host.className = "aporiax-live-agent-status-host";
      heading.insertAdjacentElement("afterend", host);
    }
    activeHosts.add(host);
    let root = roots.get(host);
    if (!root) {
      root = createRoot(host);
      roots.set(host, root);
    }
    root.render(<LiveAgentStatus message={message} />);
  });

  for (const host of [...roots.keys()]) {
    if (!host.isConnected || !activeHosts.has(host)) cleanupHost(host);
  }
}

function scheduleSync() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(() => {
    queued = false;
    syncLiveStatuses();
  });
}

const observer = new MutationObserver(scheduleSync);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.setInterval(() => {
  void refreshAuthoritativeTasks();
  syncLiveStatuses();
}, 700);

void refreshAuthoritativeTasks({ force: true }).finally(syncLiveStatuses);
