export function taskRuntimeDisplayCss() {
  return `
.desktop-run-duration {
  display: inline-flex;
  min-width: 0;
  height: 23px;
  align-items: center;
  padding: 0 8px;
  border: 1px solid rgba(128, 128, 144, 0.26);
  border-radius: 7px;
  color: inherit;
  background: rgba(128, 128, 144, 0.08);
  gap: 5px;
  font-size: 10.8px;
  font-weight: 620;
  line-height: 1;
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.desktop-run-duration[data-running="true"] {
  opacity: 0.9;
}
.desktop-run-duration-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.62;
}
.desktop-run-duration[data-running="true"] .desktop-run-duration-dot {
  animation: aporiax-runtime-pulse 1.4s ease-in-out infinite;
}
@keyframes aporiax-runtime-pulse {
  0%, 100% { opacity: 0.32; transform: scale(0.86); }
  50% { opacity: 0.95; transform: scale(1.12); }
}
`;
}

function taskRuntimeDisplayBootstrap() {
  if (window.__aporiaxTaskRuntimeDisplayV1) return;
  window.__aporiaxTaskRuntimeDisplayV1 = true;

  const TASKS_KEY = "aporiax.tasks.v1";

  function languageIsEnglish() {
    const lang = String(document.documentElement.lang || "").toLowerCase();
    return lang.startsWith("en");
  }

  function formatDuration(milliseconds) {
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value < 60_000) {
      const seconds = value / 1_000;
      return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
    }
    const totalSeconds = Math.floor(value / 1_000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  function readTasks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function visibleTask() {
    const title = document.querySelector(".thread-heading-copy h1")?.textContent?.trim() || "";
    const workspace = document.querySelector(".thread-heading-copy span")?.textContent?.trim() || "";
    const assistantCount = document.querySelectorAll(".message-list .assistant-message").length;
    const candidates = readTasks().filter((task) => {
      if (title && String(task?.title || "").trim() !== title) return false;
      if (workspace && String(task?.workspaceName || "").trim() !== workspace) return false;
      return true;
    });
    return (
      candidates.find(
        (task) =>
          (task.messages || []).filter((message) => message?.role === "assistant").length === assistantCount,
      ) || candidates[0] || null
    );
  }

  function addDurationChip(heading, message) {
    let chip = heading.querySelector(":scope > .desktop-run-duration");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "desktop-run-duration";
      chip.innerHTML = '<span class="desktop-run-duration-dot"></span><span class="desktop-run-duration-value"></span>';
      heading.appendChild(chip);
    }

    const start = Date.parse(message?.createdAt || message?.anchor?.startedAt || "");
    const completed = Date.parse(message?.completedAt || message?.anchor?.completedAt || "");
    if (!Number.isFinite(start)) {
      chip.remove();
      return;
    }

    const running = message?.status === "running" && !Number.isFinite(completed);
    const end = running ? Date.now() : Number.isFinite(completed) ? completed : Date.now();
    const label = formatDuration(Math.max(0, end - start));
    chip.dataset.running = running ? "true" : "false";
    const valueNode = chip.querySelector(".desktop-run-duration-value");
    if (valueNode && valueNode.textContent !== label) valueNode.textContent = label;
    const title = languageIsEnglish()
      ? `Task runtime · ${label}`
      : `本次任务运行时间 · ${label}`;
    if (chip.title !== title) chip.title = title;
  }

  function refresh() {
    const task = visibleTask();
    if (!task) return;
    const messages = (task.messages || []).filter((message) => message?.role === "assistant");
    const headings = [...document.querySelectorAll(".message-list .assistant-message .assistant-message-heading")];
    headings.forEach((heading, index) => {
      const message = messages[index];
      if (!message) {
        heading.querySelector(":scope > .desktop-run-duration")?.remove();
        return;
      }
      addDurationChip(heading, message);
    });
  }

  let refreshQueued = false;
  const observer = new MutationObserver(() => {
    if (refreshQueued) return;
    refreshQueued = true;
    window.requestAnimationFrame(() => {
      refreshQueued = false;
      refresh();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(refresh, 1_000);
  refresh();
}

export function taskRuntimeDisplayScript() {
  return `(${taskRuntimeDisplayBootstrap.toString()})();`;
}
