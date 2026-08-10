import React from "react";
import { createRoot } from "react-dom/client";
import { Sparkles } from "lucide-react";
import {
  readTaskListFromStorage,
  selectVisibleTask,
} from "./runtime-ui-core.js";
import "./skill-status.css";

let host = null;
let root = null;
let latestWorkspace = "";
let state = { loading: false, data: null, error: "" };
let refreshPromise = null;
let lastRefresh = 0;
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
  const tasks = readTaskListFromStorage(window.localStorage);
  return selectVisibleTask(tasks, visibleTaskDescriptor()) || null;
}

function sourceLabel(source) {
  if (source === "project") return tr("项目", "Project");
  if (source === "user") return tr("用户", "User");
  return tr("内置", "Built-in");
}

function SkillCard() {
  const skills = state.data?.skills || [];
  return (
    <section className="aporiax-skill-capability">
      <div className="aporiax-skill-label">Skills</div>
      <div className="aporiax-skill-card">
        <div className="aporiax-skill-heading">
          <span className="aporiax-skill-icon"><Sparkles size={15} /></span>
          <div>
            <strong>
              {state.loading
                ? tr("正在发现 Skills", "Discovering skills")
                : skills.length
                  ? tr(`${skills.length} 个 Skill 可用`, `${skills.length} skill${skills.length === 1 ? "" : "s"} available`)
                  : tr("未发现 Skill", "No skills discovered")}
            </strong>
            <span>
              {tr(
                "按任务自动匹配，也可用 /skill:name 手动启用",
                "Matched automatically per task, or activate one with /skill:name",
              )}
            </span>
          </div>
        </div>

        {state.error && <p className="aporiax-skill-error">{state.error}</p>}

        {skills.length > 0 ? (
          <div className="aporiax-skill-list">
            {skills.slice(0, 5).map((skill) => (
              <div className="aporiax-skill-item" key={`${skill.source}:${skill.name}`}>
                <div>
                  <strong>{skill.title || skill.name}</strong>
                  <span>{skill.name}</span>
                </div>
                <em>{sourceLabel(skill.source)}</em>
                <small>{skill.auto ? tr("自动", "Auto") : tr("手动", "Manual")}</small>
              </div>
            ))}
            {skills.length > 5 && (
              <div className="aporiax-skill-more">
                {tr(`另有 ${skills.length - 5} 个`, `${skills.length - 5} more`)}
              </div>
            )}
          </div>
        ) : !state.loading ? (
          <div className="aporiax-skill-empty">
            <p>
              {tr(
                "创建 SKILL.md 后，AporiaX 只会在匹配到任务时加载完整指令，不会把所有 Skill 都塞进上下文。",
                "Add a SKILL.md and AporiaX will load its full instructions only when the task matches, instead of placing every skill in context.",
              )}
            </p>
            <code>.aporiax/skills/&lt;name&gt;/SKILL.md</code>
          </div>
        ) : null}

        <div className="aporiax-skill-footnote">
          <span>{tr("声明式 · 不执行 JS", "Declarative · no JS execution")}</span>
          <span>{tr("不扩大工具权限", "Does not expand tool permissions")}</span>
        </div>
      </div>
    </section>
  );
}

function cleanup() {
  if (root) {
    try {
      root.unmount();
    } catch {
      // Presentation-only cleanup.
    }
  }
  root = null;
  host?.remove();
  host = null;
}

function render() {
  const panel = document.querySelector(".settings-panel");
  if (!panel) {
    if (host && !host.isConnected) cleanup();
    return;
  }
  if (!host || !host.isConnected || host.parentElement !== panel) {
    cleanup();
    host = document.createElement("div");
    host.className = "aporiax-skill-capability-host";
    panel.appendChild(host);
    root = createRoot(host);
  }
  root.render(<SkillCard />);
}

async function refresh({ force = false } = {}) {
  const workspacePath = currentVisibleTask()?.workspacePath || "";
  if (!window.desktop?.core?.skills) return;
  const now = Date.now();
  if (
    !force &&
    workspacePath === latestWorkspace &&
    now - lastRefresh < 4_000
  ) {
    render();
    return;
  }
  if (refreshPromise) return refreshPromise;
  latestWorkspace = workspacePath;
  lastRefresh = now;
  state = { ...state, loading: true, error: "" };
  render();
  refreshPromise = Promise.resolve(
    window.desktop.core.skills({ workspacePath }),
  )
    .then((data) => {
      state = { loading: false, data: data || { skills: [] }, error: "" };
    })
    .catch((error) => {
      state = {
        loading: false,
        data: { skills: [] },
        error: String(error?.message || error || tr("Skill 发现失败", "Skill discovery failed")),
      };
    })
    .finally(() => {
      refreshPromise = null;
      render();
    });
  return refreshPromise;
}

function scheduleRender() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(() => {
    queued = false;
    render();
    if (document.querySelector(".settings-panel")) void refresh();
  });
}

const observer = new MutationObserver(scheduleRender);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.setInterval(() => {
  if (document.querySelector(".settings-panel")) void refresh();
}, 2_000);

void refresh({ force: true });
