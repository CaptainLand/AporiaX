export const DESKTOP_AGENT_MODE_STORAGE_KEY = "aporiax.agent-mode.v1";

export function rendererTaskControlsCss() {
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
.composer-multi-agent-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  height: 29px;
  align-items: center;
  justify-content: center;
  padding: 0 9px;
  cursor: pointer;
  border: 1px solid rgba(128, 128, 144, 0.25);
  border-radius: 8px;
  color: inherit;
  background: rgba(128, 128, 144, 0.06);
  gap: 6px;
  font-size: 10.8px;
  font-weight: 620;
  line-height: 1;
  opacity: 0.72;
  transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease, transform 140ms ease;
}
.composer-multi-agent-toggle:hover:not(:disabled) {
  opacity: 0.96;
  transform: translateY(-1px);
}
.composer-multi-agent-toggle.active {
  border-color: rgba(255, 78, 118, 0.62);
  color: #ff4e76;
  background: rgba(255, 78, 118, 0.11);
  opacity: 1;
}
.composer-multi-agent-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}
.composer-multi-agent-toggle svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
@keyframes aporiax-runtime-pulse {
  0%, 100% { opacity: 0.32; transform: scale(0.86); }
  50% { opacity: 0.95; transform: scale(1.12); }
}
`;
}

function taskRuntimeControlsBootstrap() {
  if (window.__aporiaxTaskRuntimeControlsV1) return;
  window.__aporiaxTaskRuntimeControlsV1 = true;

  const MODE_KEY = "aporiax.agent-mode.v1";
  const TASKS_KEY = "aporiax.tasks.v1";
  let mode = localStorage.getItem(MODE_KEY) === "multi" ? "multi" : "single";
  let syncing = false;

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
    const tasks = readTasks();
    const candidates = tasks.filter((task) => {
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

  function updateDurationChips() {
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

  function modeIcon() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="2.2" stroke="currentColor" stroke-width="1.7"/>
        <circle cx="17" cy="7" r="2.2" stroke="currentColor" stroke-width="1.7"/>
        <circle cx="12" cy="17" r="2.2" stroke="currentColor" stroke-width="1.7"/>
        <path d="M8.8 8.4 10.8 14M15.2 8.4 13.2 14M9.2 7h5.6" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
      </svg>`;
  }

  async function syncMode(nextMode) {
    mode = nextMode === "multi" ? "multi" : "single";
    localStorage.setItem(MODE_KEY, mode);
    if (syncing) return;
    syncing = true;
    try {
      const accepted = await window.desktop?.agentMode?.set?.(mode);
      if (accepted === "multi" || accepted === "single") mode = accepted;
    } catch {
      // The renderer-side state remains authoritative for the control until the
      // desktop bridge is available again.
    } finally {
      localStorage.setItem(MODE_KEY, mode);
      syncing = false;
      updateModeButton();
    }
  }

  function updateModeButton() {
    const button = document.querySelector(".composer-multi-agent-toggle");
    if (!button) return;
    const multi = mode === "multi";
    const running = Boolean(document.querySelector(".composer-stop-button"));
    button.classList.toggle("active", multi);
    button.disabled = running;
    button.setAttribute("aria-pressed", multi ? "true" : "false");
    const text = button.querySelector("span");
    const label = multi ? "Multi" : "Single";
    if (text && text.textContent !== label) text.textContent = label;
    const title = running
      ? languageIsEnglish()
        ? "Agent mode is locked while the current task is running"
        : "当前任务运行中，Agent 模式将在任务结束后才能切换"
      : multi
        ? languageIsEnglish()
          ? "Adaptive Multi-Agent · AporiaX automatically decides when extra agents are useful"
          : "自适应多 Agent · AporiaX 会按任务复杂度自动决定是否调用额外 Agent"
        : languageIsEnglish()
          ? "Single Agent · Main only"
          : "单 Agent · 仅 Main";
    if (button.title !== title) button.title = title;
    if (button.getAttribute("aria-label") !== title) {
      button.setAttribute("aria-label", title);
    }
  }

  function ensureModeButton() {
    const toolbar = document.querySelector(".composer-toolbar-left");
    if (!toolbar) return;
    let button = toolbar.querySelector(".composer-multi-agent-toggle");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "composer-multi-agent-toggle";
      button.innerHTML = `${modeIcon()}<span></span>`;
      button.addEventListener("click", () => {
        if (button.disabled) return;
        void syncMode(mode === "multi" ? "single" : "multi");
      });
      const modelTrigger = toolbar.querySelector(".model-trigger");
      const modelHost = modelTrigger?.parentElement;
      if (modelHost && modelHost.parentElement === toolbar) {
        modelHost.insertAdjacentElement("afterend", button);
      } else {
        toolbar.appendChild(button);
      }
    }
    updateModeButton();
  }

  function refresh() {
    ensureModeButton();
    updateDurationChips();
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
  void syncMode(mode);
  refresh();
}

export function rendererTaskControlsScript() {
  return `(${taskRuntimeControlsBootstrap.toString()})();`;
}
