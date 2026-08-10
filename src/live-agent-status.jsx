import React from "react";
import { createRoot } from "react-dom/client";
import { Check, CircleStop, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { deriveLiveAgentStatus } from "./agent-process-model.js";
import {
  readTaskListFromStorage,
  selectVisibleTask,
} from "./runtime-ui-core.js";
import "./live-agent-status.css";

const roots = new Map();
const messageByArticle = new WeakMap();
const activatedSkillsByAssistant = new Map();
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
  const localTask = selectVisibleTask(localTasks, descriptor);

  // The desktop task store carries the current Harness / Witness state. The
  // localStorage copy is primarily a renderer cache and can lag behind while
  // response deltas are streaming. Use local state to identify the task, then
  // prefer the authoritative desktop copy for the actual status payload.
  if (localTask?.id) {
    const authoritativeMatch = authoritativeTasks.find(
      (task) => task?.id === localTask.id,
    );
    if (authoritativeMatch) return authoritativeMatch;
  }

  return (
    selectVisibleTask(authoritativeTasks, descriptor) ||
    localTask ||
    null
  );
}

async function refreshAuthoritativeTasks({ force = false } = {}) {
  if (!window.desktop?.tasks?.load) return;
  const now = Date.now();
  if (!force && now - lastDesktopRefresh < 450) return;
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

function LiveAgentStatus({ message, skills = [] }) {
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
        {skills.length > 0 && (
          <small className="skill" title={skills.map((skill) => skill.title || skill.name).join(", ")}>
            <Sparkles size={10} />
            {skills.length === 1
              ? skills[0].name
              : tr(`${skills.length} Skills`, `${skills.length} Skills`)}
          </small>
        )}
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

  articles.forEach((article, index) => {
    const heading = article.querySelector(":scope > .assistant-message-heading");
    const content = article.querySelector(":scope > .assistant-message-content");
    let host = article.querySelector(":scope > .aporiax-live-agent-status-host");
    const freshMessage = messages[index] || null;
    const message = freshMessage || messageByArticle.get(article) || null;

    // React can briefly update the streamed message DOM before the persisted
    // task snapshot catches up. Never remove a live-status host during that
    // transient mismatch; keep the last observable status attached instead.
    if (!heading || !content || !message) return;
    if (freshMessage) messageByArticle.set(article, freshMessage);

    if (!host) {
      host = document.createElement("div");
      host.className = "aporiax-live-agent-status-host";
      heading.insertAdjacentElement("afterend", host);
    }
    let root = roots.get(host);
    if (!root) {
      root = createRoot(host);
      roots.set(host, root);
    }
    root.render(
      <LiveAgentStatus
        message={message}
        skills={activatedSkillsByAssistant.get(message.id) || []}
      />,
    );
  });

  // Only tear down hosts whose assistant message actually left the DOM. A
  // temporary storage mismatch must not make the status row disappear.
  for (const host of [...roots.keys()]) {
    if (!host.isConnected) cleanupHost(host);
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

window.desktop?.harness?.onEvent?.((event) => {
  if (event?.type === "skill.activated" && event?.assistantId) {
    activatedSkillsByAssistant.set(
      event.assistantId,
      Array.isArray(event.skills) ? event.skills : [],
    );
  }

  // Harness events are a better live-status clock than response text
  // mutations. Pull the desktop snapshot immediately so tool / plan / Witness
  // state stays visible while Markdown is streaming.
  void refreshAuthoritativeTasks({ force: true }).finally(scheduleSync);
});

window.setInterval(() => {
  void refreshAuthoritativeTasks().finally(scheduleSync);
}, 650);

void refreshAuthoritativeTasks({ force: true }).finally(syncLiveStatuses);
