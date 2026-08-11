import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "diff";
import {
  AlertTriangle,
  ArrowUp,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Eye,
  FileCode2,
  FileText,
  Files,
  Folder,
  FolderOpen,
  HardDrive,
  History,
  ImagePlus,
  Info,
  KeyRound,
  Languages,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Palette,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  SquarePen,
  Moon,
  Sun,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  ApprovalCard,
  DiffReviewPanel,
  FileExplorerPanel,
  UserAttachments,
} from "./agent-components";
import {
  buildWitnessRouteBlocks,
  closeRunningRouteEntries,
  collectTaskRouteRuns,
  enrichRouteEntries,
  getRouteToolMeta,
  summarizeRoutePrompt,
  updateRunAssistant,
} from "./p0-model";
import WelcomeParticleOcean from "./WelcomeParticleOcean";
import {
  I18nProvider,
  LanguageSwitch,
  useI18n,
} from "./i18n";
import { Composer } from "./composer/Composer.jsx";
import { Conversation, RouteView } from "./conversation/ConversationViews.jsx";
import { SettingsPanel } from "./settings/SettingsPanel.jsx";
import { ExtensionsSettings } from "./settings/ExtensionsSettings.jsx";
import { IconButton, SegmentedControl, Switch } from "./components/Controls.jsx";
import {
  getAvailableModels,
  getDefaultTaskConfig,
  getModel,
} from "./models/model-catalog.js";
import {
  replaceAssistantForRetry,
  serializeTaskCache,
} from "./state/task-store-core.js";
import { useTaskStore } from "./state/useTaskStore.js";
import { useHarnessEvents } from "./hooks/useHarnessEvents.js";
import "./styles.css";

const STORAGE_KEY = "aporiax.tasks.v1";
const SIDEBAR_COLLAPSED_KEY = "aporiax.sidebar-collapsed.v1";
const SETTINGS_PANEL_WIDTH_KEY = "aporiax.settings-panel-width.v1";
const FILES_PANEL_WIDTH_KEY = "aporiax.files-panel-width.v1";
const THEME_STORAGE_KEY = "aporiax.theme.v1";
const DEFAULT_SETTINGS_PANEL_WIDTH = 320;
const DEFAULT_FILES_PANEL_WIDTH = 520;
const APP_ICON_URL = `${import.meta.env.BASE_URL}aporiax-icon.png`;

function mergeRecoverableRuns(tasks, records, tr) {
  if (!Array.isArray(records) || records.length === 0) return tasks;
  const byTask = new Map();
  for (const record of records) {
    if (!record?.taskId || !record?.assistantId) continue;
    const bucket = byTask.get(record.taskId) || [];
    bucket.push(record);
    byTask.set(record.taskId, bucket);
  }
  return tasks.map((task) => {
    const recoverable = byTask.get(task.id) || [];
    if (!recoverable.length) return task;
    let messages = [...task.messages];
    for (const record of recoverable) {
      const recovery = {
        runId: record.runId,
        startedAt: record.startedAt || null,
        workspacePath: record.workspacePath || task.workspacePath,
      };
      const existingIndex = messages.findIndex(
        (message) => message.id === record.assistantId,
      );
      const recoveryContent = tr(
        "AporiaX 上次退出时这项任务仍在执行。运行日志和工作区修改已保留，可以从当前检查点恢复。",
        "This task was still running when AporiaX last closed. Its run journal and workspace changes were preserved, so it can resume from the current checkpoint.",
      );
      if (existingIndex >= 0) {
        messages[existingIndex] = {
          ...messages[existingIndex],
          status: "interrupted",
          error: false,
          content: messages[existingIndex].content || recoveryContent,
          prompt: messages[existingIndex].prompt || record.prompt,
          sourceUserId:
            messages[existingIndex].sourceUserId || record.sourceUserId,
          recoverable: recovery,
        };
        continue;
      }
      messages.push({
        id: record.assistantId,
        role: "assistant",
        status: "interrupted",
        error: false,
        content: recoveryContent,
        prompt: record.prompt || "",
        sourceUserId: record.sourceUserId || "",
        route: [],
        steps: [],
        changes: [],
        recoverable: recovery,
        createdAt: record.startedAt || new Date().toISOString(),
      });
    }
    return { ...task, messages };
  });
}

function migrateLegacyLocalStorage() {
  const migrations = [
    ["deepagent.tasks.v1", STORAGE_KEY],
    ["deepagent.sidebar-collapsed.v1", SIDEBAR_COLLAPSED_KEY],
    ["deepagent.settings-panel-width.v1", SETTINGS_PANEL_WIDTH_KEY],
    ["deepagent.files-panel-width.v1", FILES_PANEL_WIDTH_KEY],
  ];
  for (const [legacyKey, currentKey] of migrations) {
    if (
      localStorage.getItem(currentKey) === null &&
      localStorage.getItem(legacyKey) !== null
    ) {
      localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
    }
  }
}

migrateLegacyLocalStorage();

function readSavedTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) === "light"
    ? "light"
    : "dark";
}

function readPanelWidth(storageKey, fallback, minimum, maximum) {
  const saved = Number(localStorage.getItem(storageKey));
  if (!Number.isFinite(saved)) return fallback;
  return Math.min(maximum, Math.max(minimum, saved));
}

function readSavedTasks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return normalizeTaskProjects(Array.isArray(saved) ? saved : []);
  } catch {
    return [];
  }
}

function cacheTasksLocally(tasks) {
  try {
    const snapshot = serializeTaskCache(tasks, {
      maxTasks: Number.MAX_SAFE_INTEGER,
    });
    localStorage.setItem(STORAGE_KEY, snapshot.json);
  } catch {
    try {
      const fallback = serializeTaskCache(tasks, {
        maxBytes: 0,
        maxTasks: 20,
      });
      localStorage.setItem(STORAGE_KEY, fallback.json);
    } catch {
      // Desktop persistence remains authoritative when browser quota is full.
    }
  }
}

function getFolderName(folderPath) {
  if (!folderPath) return "";
  const parts = folderPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || folderPath;
}

function normalizeWorkspacePath(folderPath) {
  return String(folderPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function projectIdForWorkspace(workspacePath) {
  const normalized = normalizeWorkspacePath(workspacePath);
  return normalized ? `workspace:${normalized}` : "workspace:unbound";
}

function normalizeTaskProjects(tasks) {
  return (tasks || []).map((task) => ({
    ...task,
    workspaceName:
      task.workspaceName ||
      getFolderName(task.workspacePath) ||
      "No workspace",
    projectId:
      task.projectId || projectIdForWorkspace(task.workspacePath),
  }));
}

function buildWorkspaceProjects(tasks) {
  const projects = new Map();
  for (const task of tasks || []) {
    const projectId = task.projectId || projectIdForWorkspace(task.workspacePath);
    const current = projects.get(projectId) || {
      id: projectId,
      name:
        task.workspaceName ||
        getFolderName(task.workspacePath) ||
        "No workspace",
      path: task.workspacePath || null,
      tasks: [],
    };
    current.tasks.push(task);
    projects.set(projectId, current);
  }
  return [...projects.values()];
}

function AppTitlebar({ onOpenSettings }) {
  const { tr } = useI18n();
  return (
    <header className="titlebar">
      <button
        className="titlebar-brand"
        type="button"
        onClick={onOpenSettings}
        aria-label={tr("打开 AporiaX 设置", "Open AporiaX settings")}
        title={tr("打开设置", "Open settings")}
      >
        <span className="brand-mark">
          <img src={APP_ICON_URL} alt="" aria-hidden="true" />
        </span>
        <span>AporiaX</span>
      </button>
      <div className="titlebar-drag" />
    </header>
  );
}

function WelcomeOverlay({ onContinue }) {
  return (
    <div className="welcome-backdrop">
      <WelcomeParticleOcean />
      <section
        className="welcome-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        aria-describedby="welcome-subtitle"
      >
        <h1 id="welcome-title">
          <span>Every problem begins</span>
          <span>
            with an <em>aporia.</em>
          </span>
        </h1>
        <p id="welcome-subtitle">每个答案，都始于一个尚未解开的疑问。</p>
        <button
          className="welcome-enter"
          type="button"
          aria-label="Enter AporiaX"
          onClick={onContinue}
        >
          Enter
          <ArrowRight size={16} />
        </button>
      </section>
      <LanguageSwitch className="welcome-language-switch" />
    </div>
  );
}

function Sidebar({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  onRenameTask,
  onDeleteTask,
  onNotice,
  runningTaskIds,
  searchOpen,
  onToggleSearch,
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTask, setRenameTask] = useState(null);
  const [deleteTask, setDeleteTask] = useState(null);
  const [collapsedProjects, setCollapsedProjects] = useState(
    () => new Set(),
  );
  const searchRef = useRef(null);
  const contextMenuRef = useRef(null);
  const filteredTasks = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return tasks;
    return tasks.filter((task) =>
      `${task.title} ${task.workspaceName}`.toLowerCase().includes(keyword),
    );
  }, [query, tasks]);
  const projects = useMemo(
    () => buildWorkspaceProjects(filteredTasks),
    [filteredTasks],
  );

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
    if (!searchOpen) setQuery("");
  }, [searchOpen]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = (event) => {
      if (!contextMenuRef.current?.contains(event.target)) {
        setContextMenu(null);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
    };
  }, [contextMenu]);

  const contextTask = tasks.find(
    (task) => task.id === contextMenu?.taskId,
  );

  const copyTaskWorkspace = async (task) => {
    if (!task?.workspacePath) return;
    try {
      await navigator.clipboard.writeText(task.workspacePath);
      onNotice(tr("工作目录路径已复制", "Workspace path copied"));
    } catch {
      onNotice(
        tr(
          "无法复制工作目录路径",
          "Unable to copy the workspace path",
        ),
      );
    }
    setContextMenu(null);
  };

  const openTaskWorkspace = async (task) => {
    if (!task?.workspacePath || !window.desktop?.openWorkspace) return;
    try {
      await window.desktop.openWorkspace(task.workspacePath);
    } catch {
      onNotice(
        tr("无法打开工作目录", "Unable to open the workspace"),
      );
    }
    setContextMenu(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-heading">
          <span>{tr("项目", "Projects")}</span>
          <IconButton label={tr("搜索项目或任务", "Search projects or tasks")} onClick={onToggleSearch}>
            <Search size={16} />
          </IconButton>
        </div>

        <button className="new-task-button" onClick={() => onNewTask()}>
          <SquarePen size={17} />
          <span>{tr("新建任务", "New task")}</span>
          <span className="new-task-shortcut">Ctrl N</span>
        </button>

        {searchOpen && (
          <div className="sidebar-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("搜索项目或任务", "Search projects or tasks")}
              aria-label={tr("搜索项目或任务", "Search projects or tasks")}
            />
            {query && (
              <button aria-label={tr("清空搜索", "Clear search")} onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="task-list">
        <div className="section-label">{tr("项目", "Projects")}</div>
        {projects.length ? (
          projects.map((project) => {
            const collapsed = collapsedProjects.has(project.id) && !query;
            return (
              <section className="sidebar-project" key={project.id}>
                <div className="sidebar-project-row">
                  <button
                    className="sidebar-project-toggle"
                    type="button"
                    onClick={() =>
                      setCollapsedProjects((current) => {
                        const next = new Set(current);
                        if (next.has(project.id)) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      })
                    }
                    title={project.path || project.name}
                  >
                    {collapsed ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    {collapsed ? (
                      <Folder size={15} />
                    ) : (
                      <FolderOpen size={15} />
                    )}
                    <span>
                      {project.path
                        ? project.name
                        : tr("无工作区", "No workspace")}
                    </span>
                    <small>{project.tasks.length}</small>
                  </button>
                  <button
                    className="sidebar-project-add"
                    type="button"
                    aria-label={tr(
                      "在 {name} 中新建任务",
                      "New task in {name}",
                      { name: project.name },
                    )}
                    title={tr("在此项目中新建任务", "New task in this project")}
                    onClick={() => onNewTask(project.id)}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {!collapsed && (
                  <div className="sidebar-project-tasks">
                    {project.tasks.map((task) => (
                      <button
                        key={task.id}
                        className={`task-item ${task.id === activeTaskId ? "active" : ""}`}
                        onClick={() => {
                          setContextMenu(null);
                          onSelectTask(task.id);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          onSelectTask(task.id);
                          setContextMenu({
                            taskId: task.id,
                            x: Math.min(
                              event.clientX,
                              Math.max(10, window.innerWidth - 218),
                            ),
                            y: Math.min(
                              event.clientY,
                              Math.max(10, window.innerHeight - 230),
                            ),
                          });
                        }}
                      >
                        <MessageSquare size={14} />
                        <span className="task-item-copy">
                          <span className="task-item-title">{task.title}</span>
                        </span>
                        {runningTaskIds.has(task.id) && (
                          <LoaderCircle className="spin task-running" size={13} />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        ) : (
          <div className="sidebar-empty">
            {tasks.length
              ? tr("没有匹配的任务", "No matching tasks")
              : tr("暂无任务", "No tasks yet")}
          </div>
        )}
      </div>
      {contextTask && contextMenu && (
        <div
          ref={contextMenuRef}
          className="sidebar-task-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <span className="sidebar-context-title" title={contextTask.title}>
            {contextTask.title}
          </span>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRenameTask(contextTask);
              setContextMenu(null);
            }}
          >
            <SquarePen size={15} />
            {tr("重命名任务", "Rename task")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextTask.workspacePath}
            onClick={() => void copyTaskWorkspace(contextTask)}
          >
            <Copy size={15} />
            {tr("复制工作目录路径", "Copy workspace path")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextTask.workspacePath}
            onClick={() => void openTaskWorkspace(contextTask)}
          >
            <FolderOpen size={15} />
            {tr("在资源管理器中打开", "Open in File Explorer")}
          </button>
          <div className="sidebar-context-divider" />
          <button
            className="danger"
            type="button"
            role="menuitem"
            disabled={runningTaskIds.has(contextTask.id)}
            onClick={() => {
              setDeleteTask(contextTask);
              setContextMenu(null);
            }}
          >
            <Trash2 size={15} />
            {runningTaskIds.has(contextTask.id)
              ? tr("运行中，无法删除", "Running; cannot delete")
              : tr("删除任务", "Delete task")}
          </button>
        </div>
      )}
      {renameTask && (
        <RenameTaskModal
          task={renameTask}
          onClose={() => setRenameTask(null)}
          onRename={(title) => {
            onRenameTask(renameTask.id, title);
            setRenameTask(null);
          }}
        />
      )}
      {deleteTask && (
        <DeleteTaskModal
          task={deleteTask}
          onClose={() => setDeleteTask(null)}
          onDelete={() => {
            onDeleteTask(deleteTask.id);
            setDeleteTask(null);
          }}
        />
      )}
    </aside>
  );
}

function NewTaskModal({
  providers,
  projects = [],
  initialProjectId = "",
  onClose,
  onCreate,
  onNotice,
}) {
  const { tr } = useI18n();
  const initialProject = projects.find(
    (project) => project.id === initialProjectId && project.path,
  );
  const [projectId, setProjectId] = useState(initialProject?.id || "");
  const [workspacePath, setWorkspacePath] = useState(
    initialProject?.path || "",
  );
  const [workspaceName, setWorkspaceName] = useState(
    initialProject?.name || "",
  );
  const [title, setTitle] = useState("");
  const [config, setConfig] = useState(() =>
    getDefaultTaskConfig(providers),
  );
  const [selectingFolder, setSelectingFolder] = useState(false);
  const titleRef = useRef(null);
  const hasModels = getAvailableModels(providers).length > 0;

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectWorkspace = async () => {
    setSelectingFolder(true);
    try {
      if (window.desktop?.selectDirectory) {
        const result = await window.desktop.selectDirectory();
        const selectedPath =
          typeof result === "string" ? result : result?.path;
        if (selectedPath) {
          setProjectId("");
          setWorkspacePath(selectedPath);
          setWorkspaceName(result?.name || getFolderName(selectedPath));
          setTimeout(() => titleRef.current?.focus(), 0);
        }
        return;
      }

      if (window.showDirectoryPicker) {
        const handle = await window.showDirectoryPicker();
        setProjectId("");
        setWorkspacePath(handle.name);
        setWorkspaceName(handle.name);
        setTimeout(() => titleRef.current?.focus(), 0);
        return;
      }

      onNotice(tr("请在 Electron 桌面端选择工作目录。", "Choose a workspace in the Electron desktop app."));
    } catch (error) {
      if (error?.name !== "AbortError") {
        onNotice(tr("无法读取所选目录，请重试。", "Unable to read that folder. Try again."));
      }
    } finally {
      setSelectingFolder(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if ((!workspacePath && !trimmedTitle) || !hasModels) return;
    onCreate({
      ...config,
      title:
        trimmedTitle ||
        (workspaceName
          ? tr("{name} 中的新任务", "New task in {name}", { name: workspaceName })
          : tr("新任务", "New task")),
      workspacePath: workspacePath || null,
      workspaceName: workspaceName || tr("无工作区", "No workspace"),
      projectId:
        projectId || projectIdForWorkspace(workspacePath),
      permission: workspacePath ? config.permission : "read-only",
    });
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className="new-task-modal" onSubmit={submit}>
        <div className="modal-header">
          <h2>{tr("新建任务", "New task")}</h2>
          <IconButton label={tr("关闭", "Close")} type="button" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="modal-body">
          {projects.length > 0 && (
            <section className="form-section">
              <label className="field-label" htmlFor="task-project">
                {tr("所属项目", "Project")}
              </label>
              <select
                id="task-project"
                className="text-field project-select"
                value={projectId}
                onChange={(event) => {
                  const nextProject = projects.find(
                    (project) => project.id === event.target.value,
                  );
                  setProjectId(nextProject?.id || "");
                  setWorkspacePath(nextProject?.path || "");
                  setWorkspaceName(nextProject?.name || "");
                }}
              >
                <option value="">
                  {tr("选择新的工作区…", "Choose a new workspace…")}
                </option>
                {projects
                  .filter((project) => project.path)
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name} · {project.tasks.length} {tr("个任务", "tasks")}
                    </option>
                  ))}
              </select>
              <p className="field-hint">
                {tr(
                  "一个工作区对应一个项目，同一项目可以包含多个独立任务。",
                  "One workspace is one project, and each project can contain multiple tasks.",
                )}
              </p>
            </section>
          )}
          <section className="form-section">
            <label className="field-label">
              {tr("项目工作区", "Project workspace")}
            </label>
            <button
              className={`workspace-picker ${workspacePath ? "has-value" : ""}`}
              type="button"
              onClick={selectWorkspace}
              disabled={selectingFolder}
            >
              <span className="workspace-picker-icon">
                {workspacePath ? <FolderOpen size={20} /> : <Folder size={20} />}
              </span>
              <span className="workspace-picker-copy">
                <span>
                  {workspaceName ||
                    (selectingFolder
                      ? tr("正在打开目录…", "Opening folder…")
                      : tr("选择一个本地文件夹", "Choose a local folder"))}
                </span>
                {workspacePath && <small>{workspacePath}</small>}
              </span>
              <span className="workspace-picker-action">
                {workspacePath ? tr("更改", "Change") : tr("浏览", "Browse")}
              </span>
            </button>
          </section>

          <section className="form-section">
            <label className="field-label" htmlFor="task-title">
              {tr("任务名称", "Task name")} <span>{tr("可选", "Optional")}</span>
            </label>
            <input
              id="task-title"
              ref={titleRef}
              className="text-field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={
                workspaceName
                  ? tr("{name} 中的新任务", "New task in {name}", { name: workspaceName })
                  : tr("例如：实现登录页面", "For example: build a sign-in page")
              }
              maxLength={80}
            />
          </section>

          <section className="form-section">
            <label className="field-label">{tr("文件权限", "File access")}</label>
            <SegmentedControl
              value={config.permission}
              ariaLabel={tr("文件权限", "File access")}
              options={[
                { value: "read-only", label: tr("只读", "Read only") },
                { value: "workspace-write", label: tr("工作区读写", "Workspace write") },
              ]}
              onChange={(permission) =>
                setConfig((current) => ({ ...current, permission }))
              }
            />
          </section>

          <section className="form-section configuration-card">
            <div className="config-row">
              <div className="config-copy">
                <div className="config-title">
                  <ShieldCheck size={16} />
                  <span>{tr("命令自动执行", "Automatic command execution")}</span>
                </div>
                <p>
                  {tr(
                    "命令默认在本地临时工作区自动执行；Docker 可选，用于加强系统级隔离。",
                    "Commands run automatically in a temporary local workspace. Docker is optional for stronger system isolation.",
                  )}
                </p>
              </div>
              <Switch
                checked={config.approvalMode !== "manual"}
                label={tr("命令自动执行", "Automatic command execution")}
                onChange={(enabled) =>
                  setConfig((current) => ({
                    ...current,
                    approvalMode: enabled ? "sandbox-auto" : "manual",
                  }))
                }
              />
            </div>
          </section>
        </div>

        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            {tr("取消", "Cancel")}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={
              !hasModels || (!workspacePath && !title.trim())
            }
          >
            {tr("创建任务", "Create task")}
          </button>
        </div>
      </form>
    </div>
  );
}

function EmptyState({ onNewTask }) {
  const { tr } = useI18n();
  return (
    <main className="empty-state">
      <h1>{tr("从一个疑问开始。", "Begin with an aporia.")}</h1>
      <p>
        {tr(
          "写代码、制作文档、演示文稿与表格。告诉 AporiaX，你想抵达哪里。",
          "Write code, create documents, presentations, and spreadsheets. Tell AporiaX where you want to arrive.",
        )}
      </p>
      <button className="primary-button large" onClick={onNewTask}>
        <Plus size={17} />
        {tr("新建任务", "New task")}
      </button>
      <div className="empty-state-meta">
        <span>
          <HardDrive size={14} />
          {tr("本地工作区", "Local workspace")}
        </span>
        <span>
          <LockKeyhole size={14} />
          {tr("权限可控", "Controlled access")}
        </span>
      </div>
    </main>
  );
}

function RenameTaskModal({ task, onClose, onRename }) {
  const { tr } = useI18n();
  const [title, setTitle] = useState(task.title || "");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const submit = (event) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) return;
    onRename(nextTitle);
  };

  return (
    <div className="modal-backdrop">
      <form className="rename-task-modal" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <h2>{tr("重命名任务", "Rename task")}</h2>
            <p>{tr("任务记录和工作目录不会发生变化。", "Task history and workspace will not change.")}</p>
          </div>
          <IconButton label={tr("关闭", "Close")} type="button" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="api-key-body">
          <label className="field-label" htmlFor="rename-task-title">
            {tr("任务名称", "Task name")}
          </label>
          <input
            id="rename-task-title"
            ref={inputRef}
            className="text-field"
            value={title}
            maxLength={80}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            {tr("取消", "Cancel")}
          </button>
          <button className="primary-button" type="submit" disabled={!title.trim()}>
            {tr("保存", "Save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteTaskModal({ task, onClose, onDelete }) {
  const { tr } = useI18n();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop delete-task-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="delete-task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-task-title"
      >
        <div className="delete-task-heading">
          <span>
            <Trash2 size={18} />
          </span>
          <div>
            <h2 id="delete-task-title">
              {tr("删除这个任务？", "Delete this task?")}
            </h2>
            <p>{task.title}</p>
          </div>
        </div>
        <p className="delete-task-description">
          {tr(
            "任务对话、Route 记录和文件检查点将从 AporiaX 中移除。工作区中的真实文件不会被删除或回退。",
            "The conversation, Route history, and file checkpoints will be removed from AporiaX. Files in the workspace will not be deleted or reverted.",
          )}
        </p>
        <div className="delete-task-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            {tr("取消", "Cancel")}
          </button>
          <button className="delete-task-confirm" type="button" onClick={onDelete}>
            {tr("删除任务", "Delete task")}
          </button>
        </div>
      </section>
    </div>
  );
}

function PanelResizer({ panelName, width, minimum, maximum, onResize }) {
  const { tr } = useI18n();
  const startResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.classList.add("panel-is-resizing");

    const handlePointerMove = (moveEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX;
      onResize(Math.min(maximum, Math.max(minimum, nextWidth)));
    };
    const finishResize = () => {
      document.body.classList.remove("panel-is-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  const handleKeyDown = (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResize(Math.min(maximum, width + 16));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResize(Math.max(minimum, width - 16));
    }
  };

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-label={tr("调整面板宽度", "Resize panel")}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onDoubleClick={() =>
        onResize(
          panelName === "settings"
            ? DEFAULT_SETTINGS_PANEL_WIDTH
            : DEFAULT_FILES_PANEL_WIDTH,
        )
      }
      onKeyDown={handleKeyDown}
      onPointerDown={startResize}
    >
      <span />
    </div>
  );
}

function collectTaskAnchors(task) {
  const userMessages = new Map(
    (task.messages || [])
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message]),
  );

  return (task.messages || [])
    .filter(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.changes) &&
        message.changes.length > 0,
    )
    .map((message, index) => {
      const source = userMessages.get(message.sourceUserId);
      const activeChanges = message.changes.filter(
        (change) => !change.reverted,
      );
      return {
        id: message.id,
        number: index + 1,
        prompt:
          message.prompt?.trim() ||
          source?.content?.trim() ||
          "AporiaX task",
        createdAt:
          message.anchor?.startedAt ||
          message.createdAt ||
          message.completedAt,
        completedAt:
          message.anchor?.completedAt || message.completedAt,
        status: message.anchor?.status || message.status || "completed",
        changes: message.changes,
        activeChanges,
        snapshotComplete:
          message.anchor?.snapshotComplete !== false,
        warning: message.anchor?.warning || "",
        restoredAt: message.anchorRestoredAt || "",
      };
    });
}

function AnchorHistory({
  task,
  isRunning,
  onRestore,
}) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const anchors = useMemo(() => collectTaskAnchors(task), [task]);
  const visibleAnchors = expanded
    ? [...anchors].reverse()
    : anchors.length
      ? [anchors.at(-1)]
      : [];

  const requestRestore = async (anchor) => {
    if (confirmId !== anchor.id) {
      setConfirmId(anchor.id);
      return;
    }
    setRestoringId(anchor.id);
    try {
      const result = await onRestore(anchor.id);
      if (result?.success) {
        setConfirmId("");
      }
    } finally {
      setRestoringId("");
    }
  };

  if (!anchors.length) {
    return (
      <section className="anchor-history empty">
        <div className="anchor-history-heading">
          <span className="anchor-history-mark">
            <History size={16} />
          </span>
          <div>
            <strong>Anchor</strong>
            <span>
              {tr(
                "完成一次会修改文件的任务后，这里会保留跨轮快照。",
                "Cross-turn snapshots appear after a task changes files.",
              )}
            </span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`anchor-history ${expanded ? "expanded" : ""}`}>
      <button
        className="anchor-history-heading"
        type="button"
        onClick={() => {
          setExpanded((open) => !open);
          setConfirmId("");
        }}
        aria-expanded={expanded}
      >
        <span className="anchor-history-mark">
          <History size={16} />
        </span>
        <div>
          <strong>Anchor</strong>
          <span>
            {tr(
              "{count} 个跨轮快照 · 恢复前会检查后续改动",
              "{count} cross-turn snapshot(s) · conflicts are checked before restore",
              { count: anchors.length },
            )}
          </span>
        </div>
        <ChevronDown size={15} />
      </button>

      <div className="anchor-history-list">
        {visibleAnchors.map((anchor) => {
          const anchorIndex = anchors.findIndex(
            (candidate) => candidate.id === anchor.id,
          );
          const affected = anchors
            .slice(anchorIndex)
            .filter((candidate) => candidate.activeChanges.length > 0);
          const affectedFiles = new Set(
            affected.flatMap((candidate) =>
              candidate.activeChanges.map((change) => change.path),
            ),
          );
          const restoring = restoringId === anchor.id;
          const restored = anchor.activeChanges.length === 0;
          return (
            <article
              className={`anchor-history-item ${restored ? "restored" : ""}`}
              key={anchor.id}
            >
              <span className="anchor-index">
                {String(anchor.number).padStart(2, "0")}
              </span>
              <div className="anchor-copy">
                <strong title={anchor.prompt}>{anchor.prompt}</strong>
                <span>
                  {tr(
                    "{count} 个文件 · {status}",
                    "{count} file(s) · {status}",
                    {
                      count: anchor.changes.length,
                      status: restored
                        ? tr("已恢复", "restored")
                        : anchor.snapshotComplete
                          ? tr("快照完整", "snapshot ready")
                          : tr("部分快照", "partial snapshot"),
                    },
                  )}
                </span>
                {anchor.warning && (
                  <em title={anchor.warning}>
                    {tr("部分文件未进入快照", "Some files were not captured")}
                  </em>
                )}
                {confirmId === anchor.id && !restored && (
                  <span className="anchor-confirm-copy">
                    {tr(
                      "将回到本轮开始前，并撤销其后的 {turns} 轮、共 {files} 个文件。工作区若有额外改动，恢复会安全停止。",
                      "Return to the state before this turn, reverting {turns} turn(s) across {files} file(s). Restore stops safely if later edits are detected.",
                      {
                        turns: affected.length,
                        files: affectedFiles.size,
                      },
                    )}
                  </span>
                )}
              </div>
              <div className="anchor-actions">
                {confirmId === anchor.id && !restored && (
                  <button
                    type="button"
                    className="anchor-cancel"
                    disabled={restoring}
                    onClick={() => setConfirmId("")}
                  >
                    {tr("取消", "Cancel")}
                  </button>
                )}
                <button
                  type="button"
                  className={confirmId === anchor.id ? "confirm" : ""}
                  disabled={isRunning || restoring || restored}
                  onClick={() => void requestRestore(anchor)}
                >
                  {restoring ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : restored ? (
                    <Check size={14} />
                  ) : (
                    <Undo2 size={14} />
                  )}
                  {restored
                    ? tr("已恢复", "Restored")
                    : confirmId === anchor.id
                      ? tr("确认恢复", "Confirm restore")
                      : tr("恢复到这里", "Restore here")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProjectUnderstandingPanel({
  task,
  refreshToken,
  onOpenFile,
  onNotice,
}) {
  const { tr } = useI18n();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmRevision, setConfirmRevision] = useState("");
  const [reverting, setReverting] = useState("");

  const loadUnderstanding = async () => {
    if (!task.workspacePath || !window.desktop?.understanding?.get) return;
    setLoading(true);
    setError("");
    try {
      setState(await window.desktop.understanding.get(task.workspacePath));
    } catch (loadError) {
      setError(
        loadError?.message ||
          tr("无法加载项目理解", "Unable to load Project Understanding"),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setState(null);
    setConfirmRevision("");
    void loadUnderstanding();
  }, [task.workspacePath, refreshToken]);

  const revertTo = async (revision) => {
    if (confirmRevision !== revision.id) {
      setConfirmRevision(revision.id);
      return;
    }
    setReverting(revision.id);
    try {
      const result = await window.desktop.understanding.revert({
        workspacePath: task.workspacePath,
        taskId: task.id,
        revisionId: revision.id,
      });
      setState(result.state);
      setConfirmRevision("");
      onNotice(
        tr(
          "项目理解已恢复到修订 {revision}，并保留了新的回退记录",
          "Project Understanding was restored from revision {revision} with a new revert record",
          { revision: revision.number },
        ),
      );
    } catch (revertError) {
      onNotice(
        revertError?.message ||
          tr("项目理解恢复失败", "Failed to restore Project Understanding"),
      );
    } finally {
      setReverting("");
    }
  };

  const categoryLabels = {
    architecture: tr("架构", "Architecture"),
    module: tr("模块", "Modules"),
    command: tr("命令", "Commands"),
    convention: tr("约定", "Conventions"),
    decision: tr("决策", "Decisions"),
    verification: tr("验证", "Verification"),
    known_issue: tr("已知问题", "Known issues"),
    preference: tr("偏好", "Preferences"),
  };
  const groupedFacts = Object.entries(
    (state?.facts || []).reduce((groups, fact) => {
      const key = fact.category || "convention";
      groups[key] = [...(groups[key] || []), fact];
      return groups;
    }, {}),
  );

  return (
    <section className="understanding-view">
      <header className="understanding-hero">
        <div className="understanding-mark">
          <Brain size={21} />
        </div>
        <div>
          <span>{tr("项目共享上下文", "Shared project context")}</span>
          <h2>Project Understanding</h2>
          <p>
            {tr(
              "由同一工作区的任务共同维护。每条理解都带有证据，并通过 revision 保留完整演进路径。",
              "Maintained across every task in this workspace. Each fact carries evidence and every change is preserved as a revision.",
            )}
          </p>
        </div>
        <button
          type="button"
          className="understanding-refresh"
          disabled={loading}
          onClick={() => void loadUnderstanding()}
        >
          <RotateCcw className={loading ? "spin" : ""} size={15} />
          {tr("刷新", "Refresh")}
        </button>
      </header>

      {error ? (
        <div className="understanding-error">
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      ) : loading && !state ? (
        <div className="understanding-loading">
          <LoaderCircle className="spin" size={20} />
          {tr("正在读取项目理解…", "Loading Project Understanding…")}
        </div>
      ) : (
        <div className="understanding-layout">
          <main className="understanding-facts">
            <div className="understanding-summary">
              <div>
                <strong>{state?.facts?.length || 0}</strong>
                <span>{tr("条已验证理解", "verified facts")}</span>
              </div>
              <div>
                <strong>{state?.currentRevision || 0}</strong>
                <span>revision</span>
              </div>
              <div>
                <strong>{groupedFacts.length}</strong>
                <span>{tr("个知识维度", "knowledge areas")}</span>
              </div>
            </div>

            {!groupedFacts.length ? (
              <div className="understanding-empty">
                <Brain size={28} />
                <h3>{tr("这个项目还没有形成共享理解", "This project has no shared Understanding yet")}</h3>
                <p>
                  {tr(
                    "完成一次包含实际修改和验证的任务后，Curator 子 Agent 会提炼第一条带证据的 revision。",
                    "Complete a task with verified workspace changes and the Curator subagent will create the first evidence-backed revision.",
                  )}
                </p>
              </div>
            ) : (
              groupedFacts.map(([category, facts]) => (
                <section className="understanding-group" key={category}>
                  <div className="understanding-group-title">
                    <span>{categoryLabels[category] || category}</span>
                    <small>{facts.length}</small>
                  </div>
                  <div className="understanding-fact-list">
                    {facts.map((fact) => (
                      <article className="understanding-fact" key={fact.id}>
                        <p>{fact.content}</p>
                        <div className="understanding-fact-meta">
                          <span>
                            {tr("置信度", "Confidence")} {Math.round((fact.confidence || 0) * 100)}%
                          </span>
                          {(fact.evidence || []).slice(0, 4).map((evidence, index) => (
                            <button
                              type="button"
                              key={`${fact.id}-evidence-${index}`}
                              disabled={evidence.type !== "file"}
                              onClick={() =>
                                evidence.type === "file" &&
                                onOpenFile(evidence.reference)
                              }
                            >
                              <FileText size={12} />
                              {evidence.reference || evidence.detail}
                            </button>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))
            )}
          </main>

          <aside className="understanding-history">
            <div className="understanding-history-title">
              <History size={16} />
              <div>
                <strong>{tr("修订历史", "Revision history")}</strong>
                <span>{tr("可追踪，也可安全回退", "Traceable and safely reversible")}</span>
              </div>
            </div>
            <div className="understanding-revisions">
              {(state?.revisions || []).length ? (
                state.revisions.map((revision) => {
                  const current = revision.number === state.currentRevision;
                  const confirming = confirmRevision === revision.id;
                  return (
                    <article
                      className={`understanding-revision ${current ? "current" : ""}`}
                      key={revision.id}
                    >
                      <div className="understanding-revision-head">
                        <span>r{revision.number}</span>
                        {current && <small>{tr("当前", "Current")}</small>}
                      </div>
                      <p>{revision.summary}</p>
                      <div className="understanding-revision-meta">
                        <span>{revision.factCount} facts</span>
                        <span>{new Date(revision.createdAt).toLocaleString()}</span>
                      </div>
                      {!current && (
                        <div className="understanding-revision-actions">
                          {confirming && (
                            <button type="button" onClick={() => setConfirmRevision("")}>
                              {tr("取消", "Cancel")}
                            </button>
                          )}
                          <button
                            type="button"
                            className={confirming ? "confirm" : ""}
                            disabled={Boolean(reverting)}
                            onClick={() => void revertTo(revision)}
                          >
                            {reverting === revision.id ? (
                              <LoaderCircle className="spin" size={13} />
                            ) : (
                              <Undo2 size={13} />
                            )}
                            {confirming
                              ? tr("确认恢复", "Confirm restore")
                              : tr("恢复此版本", "Restore")}
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })
              ) : (
                <p className="understanding-no-history">
                  {tr("完成任务后会在这里形成第一条 revision。", "The first revision will appear here after a completed task.")}
                </p>
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

function TaskWorkspace({
  task,
  providers,
  sidebarCollapsed,
  onToggleSidebar,
  settingsOpen,
  onToggleSettings,
  onSend,
  onStop,
  onPause,
  onResume,
  onRetry,
  onRevert,
  onRestoreAnchor,
  onRestoreTurnAnchor,
  onConfirmChanges,
  onSaveChanges,
  approval,
  approvalResponding,
  onRespondApproval,
  onUpdateTask,
  isRunning,
  isPaused,
  onManageProviders,
  sandboxStatus,
  sandboxPreparing,
  onPrepareSandbox,
  onSelectWorkspace,
  onNotice,
  onDeleteTask,
  theme,
  onToggleTheme,
}) {
  const { tr } = useI18n();
  const [activeView, setActiveView] = useState("dialogue");
  const [workspaceFocusPath, setWorkspaceFocusPath] = useState("");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(() =>
    readPanelWidth(
      SETTINGS_PANEL_WIDTH_KEY,
      DEFAULT_SETTINGS_PANEL_WIDTH,
      260,
      620,
    ),
  );
  const moreMenuRef = useRef(null);
  const threadBodyRef = useRef(null);
  const viewScrollMemoryRef = useRef(new Map());
  const dialogueFollowRef = useRef(true);
  const model = getModel(
    providers,
    task.providerId,
    task.modelId,
  );
  const latestMessage = task.messages.at(-1);
  const latestMessageContentLength =
    latestMessage?.role === "assistant"
      ? latestMessage.content?.length || 0
      : 0;
  const latestWitnessRevision =
    latestMessage?.role === "assistant"
      ? latestMessage.witness?.revision || 0
      : 0;

  useEffect(() => {
    setActiveView("dialogue");
    setWorkspaceFocusPath("");
    setMoreMenuOpen(false);
    setRenameOpen(false);
    setDeleteOpen(false);
  }, [task.id]);

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_PANEL_WIDTH_KEY,
      String(Math.round(settingsPanelWidth)),
    );
  }, [settingsPanelWidth]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const body = threadBodyRef.current;
      if (!body) return;
      const memory = viewScrollMemoryRef.current.get(
        `${task.id}:${activeView}`,
      );
      if (!memory) {
        body.scrollTop =
          activeView === "dialogue" ? body.scrollHeight : 0;
        if (activeView === "dialogue") dialogueFollowRef.current = true;
        return;
      }
      body.scrollTop = memory.stickToBottom
        ? body.scrollHeight
        : Math.min(memory.top, body.scrollHeight);
      if (activeView === "dialogue") {
        dialogueFollowRef.current = memory.stickToBottom;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, task.id]);

  useEffect(() => {
    if (activeView !== "dialogue" || !dialogueFollowRef.current) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const body = threadBodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeView,
    isRunning,
    latestMessageContentLength,
    latestWitnessRevision,
    task.messages.length,
  ]);

  useEffect(() => {
    if (!moreMenuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!moreMenuRef.current?.contains(event.target)) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setMoreMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreMenuOpen]);

  const switchView = (nextView) => {
    if (nextView === activeView) return;
    const body = threadBodyRef.current;
    if (body) {
      viewScrollMemoryRef.current.set(`${task.id}:${activeView}`, {
        top: body.scrollTop,
        stickToBottom:
          body.scrollHeight - body.clientHeight - body.scrollTop < 72,
      });
    }
    setActiveView(nextView);
  };

  const showFilesPanel = () => {
    switchView("workspace");
    if (settingsOpen) onToggleSettings();
    setMoreMenuOpen(false);
  };

  const showSettingsPanel = () => {
    if (!settingsOpen) onToggleSettings();
    setMoreMenuOpen(false);
  };

  const copyWorkspacePath = async () => {
    if (!task.workspacePath) return;
    try {
      await navigator.clipboard.writeText(task.workspacePath);
      onNotice(tr("工作目录路径已复制", "Workspace path copied"));
    } catch {
      onNotice(tr("无法复制工作目录路径", "Unable to copy the workspace path"));
    }
    setMoreMenuOpen(false);
  };

  const openWorkspace = async () => {
    if (!task.workspacePath || !window.desktop?.openWorkspace) {
      onNotice(tr("当前工作目录无法在资源管理器中打开", "This workspace cannot be opened in File Explorer"));
      return;
    }
    try {
      await window.desktop.openWorkspace(task.workspacePath);
    } catch {
      onNotice(tr("无法打开工作目录", "Unable to open the workspace"));
    }
    setMoreMenuOpen(false);
  };

  return (
    <div className="task-workspace">
      <section className="thread">
        <header className="thread-header">
          <div className="thread-heading">
            <IconButton
              label={sidebarCollapsed ? tr("展开任务侧栏", "Expand task sidebar") : tr("收起任务侧栏", "Collapse task sidebar")}
              className="thread-header-button"
              onClick={onToggleSidebar}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={17} />
              ) : (
                <PanelLeftClose size={17} />
              )}
            </IconButton>
            <IconButton
              label={
                task.workspacePath
                  ? tr("浏览工作区文件", "Browse workspace files")
                  : tr("绑定工作目录", "Bind workspace")
              }
              className={`thread-header-button thread-folder-button ${activeView === "workspace" ? "active" : ""}`}
              onClick={() => {
                if (!task.workspacePath) {
                  onSelectWorkspace();
                  return;
                }
                showFilesPanel();
              }}
            >
              {activeView === "workspace" ? (
                <FolderOpen size={17} />
              ) : (
                <Folder size={17} />
              )}
            </IconButton>
            <div className="thread-heading-copy">
              <h1>{task.title}</h1>
              <span>{task.workspaceName}</span>
            </div>
          </div>
          <div className="thread-actions">
            <span className="thread-model-badge">
              <model.icon size={14} />
              {model.shortName}
            </span>
            <IconButton
              label={
                theme === "dark"
                  ? tr("切换为日间模式", "Switch to light mode")
                  : tr("切换为夜间模式", "Switch to dark mode")
              }
              className={`theme-toggle ${theme === "dark" ? "active" : ""}`}
              onClick={onToggleTheme}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </IconButton>
            <IconButton
              label={settingsOpen ? tr("关闭任务设置", "Close task settings") : tr("打开任务设置", "Open task settings")}
              className={settingsOpen ? "active" : ""}
              onClick={() => {
                onToggleSettings();
              }}
            >
              <Settings2 size={18} />
            </IconButton>
            <div className="task-more-menu-wrap" ref={moreMenuRef}>
              <IconButton
                label={tr("更多操作", "More actions")}
                className={moreMenuOpen ? "active" : ""}
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
                onClick={() => setMoreMenuOpen((open) => !open)}
              >
                <Ellipsis size={18} />
              </IconButton>
              {moreMenuOpen && (
                <div className="task-more-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRenameOpen(true);
                      setMoreMenuOpen(false);
                    }}
                  >
                    <SquarePen size={15} />
                    {tr("重命名任务", "Rename task")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!task.workspacePath}
                    onClick={showFilesPanel}
                  >
                    <Files size={15} />
                    {tr("文件与代码", "Files and code")}
                  </button>
                  <button type="button" role="menuitem" onClick={showSettingsPanel}>
                    <Settings2 size={15} />
                    {tr("任务设置", "Task settings")}
                  </button>
                  <div className="task-more-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!task.workspacePath}
                    onClick={copyWorkspacePath}
                  >
                    <Copy size={15} />
                    {tr("复制工作目录路径", "Copy workspace path")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!task.workspacePath}
                    onClick={openWorkspace}
                  >
                    <HardDrive size={15} />
                    {tr("在资源管理器中打开", "Open in File Explorer")}
                  </button>
                  <div className="task-more-menu-divider" />
                  <button
                    className="danger"
                    type="button"
                    role="menuitem"
                    disabled={isRunning}
                    onClick={() => {
                      setDeleteOpen(true);
                      setMoreMenuOpen(false);
                    }}
                  >
                    <Trash2 size={15} />
                    {isRunning
                      ? tr("任务运行中，无法删除", "Cannot delete a running task")
                      : tr("删除任务", "Delete task")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <nav className="thread-view-tabs" aria-label={tr("任务视图", "Task views")}>
          {[
            { id: "dialogue", label: "Dialogue" },
            { id: "route", label: "Route" },
            { id: "workspace", label: "Workspace" },
            { id: "understanding", label: "Understanding" },
          ].map((view) => (
            <button
              className={activeView === view.id ? "active" : ""}
              type="button"
              key={view.id}
              onClick={() => {
                if (
                  ["workspace", "understanding"].includes(view.id) &&
                  !task.workspacePath
                ) {
                  onSelectWorkspace();
                  return;
                }
                switchView(view.id);
              }}
            >
              {view.label}
              {view.id === "route" && isRunning && <span />}
            </button>
          ))}
        </nav>

        <div
          ref={threadBodyRef}
          className={`thread-body ${activeView}-mode`}
          onScroll={(event) => {
            if (activeView !== "dialogue") return;
            const body = event.currentTarget;
            dialogueFollowRef.current =
              body.scrollHeight - body.clientHeight - body.scrollTop < 72;
          }}
        >
          <div
            className={`thread-view-panel dialogue-panel ${
              activeView === "dialogue" ? "active" : ""
            }`}
            aria-hidden={activeView !== "dialogue"}
          >
            <Conversation
              task={task}
              isRunning={isRunning}
              approval={approval}
              approvalResponding={approvalResponding}
              onRespondApproval={onRespondApproval}
              onRetry={onRetry}
              onRevert={onRevert}
              onRestoreTurnAnchor={onRestoreTurnAnchor}
              onConfirmChanges={onConfirmChanges}
              onSaveChanges={onSaveChanges}
              onNotice={onNotice}
            />
          </div>
          <div
            className={`thread-view-panel route-panel ${
              activeView === "route" ? "active" : ""
            }`}
            aria-hidden={activeView !== "route"}
          >
            <RouteView
              key={task.id}
              task={task}
              isRunning={isRunning}
              approval={approval}
              approvalResponding={approvalResponding}
              onRespondApproval={onRespondApproval}
              onRevert={onRevert}
              onSaveChanges={onSaveChanges}
              onNotice={onNotice}
            />
          </div>
          <div
            className={`thread-view-panel workspace-panel ${
              activeView === "workspace" ? "active" : ""
            }`}
            aria-hidden={activeView !== "workspace"}
          >
            <div className="workspace-view-stack">
              <AnchorHistory
                task={task}
                isRunning={isRunning}
                onRestore={onRestoreAnchor}
              />
              <FileExplorerPanel
                workspacePath={task.workspacePath}
                embedded
                initialPath={workspaceFocusPath}
                onNotice={onNotice}
              />
            </div>
          </div>
          <div
            className={`thread-view-panel understanding-panel ${
              activeView === "understanding" ? "active" : ""
            }`}
            aria-hidden={activeView !== "understanding"}
          >
            <ProjectUnderstandingPanel
              task={task}
              refreshToken={task.understandingRevision || 0}
              onNotice={onNotice}
              onOpenFile={(path) => {
                setWorkspaceFocusPath(path);
                switchView("workspace");
              }}
            />
          </div>
        </div>

        <Composer
          task={task}
          providers={providers}
          onSend={onSend}
          onStop={onStop}
          onPause={onPause}
          onResume={onResume}
          onUpdateTask={onUpdateTask}
          onNotice={onNotice}
          isRunning={isRunning}
          isPaused={isPaused}
          queuedCount={task.messages.filter(
            (message) => message.role === "user" && message.queued,
          ).length}
          pendingSteeringCount={task.messages.filter(
            (message) =>
              message.role === "user" &&
              message.steeringStatus === "pending",
          ).length}
        />
      </section>

      {settingsOpen ? (
        <>
          <PanelResizer
            panelName="settings"
            width={settingsPanelWidth}
            minimum={260}
            maximum={620}
            onResize={setSettingsPanelWidth}
          />
          <SettingsPanel
            task={task}
            providers={providers}
            onClose={onToggleSettings}
            onUpdateTask={onUpdateTask}
            onManageProviders={onManageProviders}
            sandboxStatus={sandboxStatus}
            sandboxPreparing={sandboxPreparing}
            onPrepareSandbox={onPrepareSandbox}
            onSelectWorkspace={onSelectWorkspace}
            style={{ flexBasis: `${settingsPanelWidth}px` }}
          />
        </>
      ) : null}
      {renameOpen && (
        <RenameTaskModal
          task={task}
          onClose={() => setRenameOpen(false)}
          onRename={(title) => {
            onUpdateTask({ title });
            setRenameOpen(false);
            onNotice(tr("任务已重命名", "Task renamed"));
          }}
        />
      )}
      {deleteOpen && (
        <DeleteTaskModal
          task={task}
          onClose={() => setDeleteOpen(false)}
          onDelete={() => {
            onDeleteTask(task.id);
            setDeleteOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}

function summarizeCompletionContent(content, fallback) {
  const clean = String(content || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[\s>*#\-+`]+/gm, "")
    .replace(/[*_~`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length > 220
    ? `${clean.slice(0, 220).trimEnd()}…`
    : clean;
}

function TaskCompletionToast({
  notification,
  onOpen,
  onClose,
}) {
  const { tr } = useI18n();
  if (!notification) return null;
  return (
    <aside
      className="task-completion-toast"
      role="status"
      aria-live="polite"
    >
      <span className="task-completion-icon">
        <Check size={16} />
      </span>
      <div className="task-completion-copy">
        <span>{tr("任务完成", "Task completed")}</span>
        <strong>{notification.title}</strong>
        <p>{notification.summary}</p>
        <button type="button" onClick={onOpen}>
          {tr("查看任务", "View task")}
          <ArrowRight size={13} />
        </button>
      </div>
      <button
        className="task-completion-close"
        type="button"
        aria-label={tr("关闭完成通知", "Dismiss completion notification")}
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </aside>
  );
}

function emptyProviderForm() {
  return {
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    modelsText: "",
  };
}

const PROVIDER_PRESETS = [
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
  },
  {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
  },
];

function providerToForm(provider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    modelsText: (provider.models || [])
      .map((model) => model.id)
      .join("\n"),
  };
}

function cleanIpcError(error, fallback) {
  return String(error?.message || fallback)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

function ProviderManagerModal({
  providers,
  onClose,
  onChanged,
  onNotice,
  onSaved,
  embedded = false,
}) {
  const { tr } = useI18n();
  const [form, setForm] = useState(() =>
    providers[0] ? providerToForm(providers[0]) : emptyProviderForm(),
  );
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef(null);
  const editingProvider = providers.find(
    (provider) => provider.id === form.id,
  );

  useEffect(() => {
    nameRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !saving && !discovering) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving, discovering]);

  const modelIds = form.modelsText
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const discoverModels = async () => {
    if (!form.baseUrl.trim() || discovering) return;
    setDiscovering(true);
    setError("");
    try {
      const result = await window.desktop.providers.discover({
        id: form.id || undefined,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      });
      setForm((current) => ({
        ...current,
        name: current.name.trim()
          ? current.name
          : result.suggestedName,
        baseUrl: result.baseUrl,
        modelsText: result.models
          .map((model) => model.id)
          .join("\n"),
      }));
      onNotice(tr("已识别 {count} 个模型", "Discovered {count} model(s)", { count: result.models.length }));
    } catch (discoverError) {
      setError(
        cleanIpcError(
          discoverError,
          tr("无法自动发现模型，可以手动填写模型 ID。", "Unable to discover models automatically. Enter model IDs manually."),
        ),
      );
    } finally {
      setDiscovering(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (
      !form.baseUrl.trim() ||
      !modelIds.length ||
      saving
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      const wasEditing = Boolean(form.id);
      const savedProvider = await window.desktop.providers.save({
        id: form.id || undefined,
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        models: modelIds,
      });
      const nextProviders = await onChanged();
      setForm(providerToForm(savedProvider));
      onNotice(wasEditing ? tr("Provider 已更新", "Provider updated") : tr("Provider 已添加", "Provider added"));
      onSaved?.({
        created: !wasEditing,
        provider: savedProvider,
        providers: nextProviders,
      });
    } catch (saveError) {
      setError(cleanIpcError(saveError, tr("保存 Provider 失败。", "Failed to save the provider.")));
    } finally {
      setSaving(false);
    }
  };

  const removeCurrentProvider = async () => {
    if (
      !editingProvider ||
      editingProvider.environmentKey ||
      !window.confirm(
        tr(
          "移除 {name}？已有任务记录不会被删除，但需要重新选择模型。",
          "Remove {name}? Existing task history will remain, but you will need to choose another model.",
          { name: editingProvider.name },
        ),
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await window.desktop.providers.remove(editingProvider.id);
      await onChanged();
      setForm(emptyProviderForm());
      onNotice(tr("Provider 已移除", "Provider removed"));
    } catch (removeError) {
      setError(cleanIpcError(removeError, tr("移除 Provider 失败。", "Failed to remove the provider.")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={
        embedded ? "provider-manager-embedded-host" : "modal-backdrop"
      }
    >
      <form
        className={`provider-manager-modal ${embedded ? "embedded" : ""}`}
        onSubmit={submit}
      >
        {!embedded && (
          <div className="modal-header">
            <div>
              <h2>{tr("模型 Provider", "Model providers")}</h2>
              <p>{tr("添加多个 OpenAI-compatible API，并为任务自由选择模型。", "Add multiple OpenAI-compatible APIs and choose any model per task.")}</p>
            </div>
            <IconButton label={tr("关闭", "Close")} type="button" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        )}

        <div className="provider-manager-body">
          <aside className="provider-list">
            {embedded && (
              <div className="provider-list-heading">
                <span>Providers</span>
                <small>{providers.length}</small>
              </div>
            )}
            <button
              className={!form.id ? "active add-provider" : "add-provider"}
              type="button"
              onClick={() => {
                setForm(emptyProviderForm());
                setError("");
              }}
            >
              <Plus size={15} />
              {tr("新增 API", "Add API")}
            </button>
            {providers.map((provider) => (
              <button
                className={form.id === provider.id ? "active" : ""}
                type="button"
                key={provider.id}
                onClick={() => {
                  setForm(providerToForm(provider));
                  setError("");
                }}
              >
                <span>
                  <strong>{provider.name}</strong>
                  <small>{tr("{count} 个模型", "{count} model(s)", { count: provider.models?.length || 0 })}</small>
                </span>
                <ChevronDown size={13} />
              </button>
            ))}
          </aside>

          <div className="provider-editor">
            {!editingProvider && (
              <div className="provider-presets">
                <span>{tr("常用服务", "Common services")}</span>
                <div>
                  {PROVIDER_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.name}
                      className={
                        form.baseUrl === preset.baseUrl ? "active" : ""
                      }
                      onClick={() => {
                        setForm((current) => ({
                          ...current,
                          name: preset.name,
                          baseUrl: preset.baseUrl,
                          modelsText: "",
                        }));
                        setError("");
                      }}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="provider-form-grid">
              <label>
                <span>{tr("名称（可选）", "Name (optional)")}</span>
                <input
                  ref={nameRef}
                  className="text-field"
                  value={form.name}
                  maxLength={80}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder={tr("例如 OpenAI、OpenRouter、本地 Ollama", "For example: OpenAI, OpenRouter, or local Ollama")}
                />
              </label>
              <label>
                <span>API Base URL</span>
                <input
                  className="text-field"
                  value={form.baseUrl}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="provider-key-field">
                <span>
                  {editingProvider?.hasApiKey
                    ? tr("替换 API Key（可选）", "Replace API key (optional)")
                    : tr("API Key", "API key")}
                </span>
                <input
                  className="text-field"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.apiKey}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }))
                  }
                  placeholder={
                    editingProvider?.hasApiKey
                      ? tr("已安全保存；留空保持不变", "Stored securely; leave blank to keep it")
                      : tr("云服务通常必填；本地无鉴权服务可留空", "Usually required for cloud services; optional for unauthenticated local APIs")
                  }
                />
              </label>
            </div>

            <div className="provider-model-heading">
              <div>
                <strong>{tr("模型 ID", "Model IDs")}</strong>
                <span>{tr("自动发现，或每行填写一个模型。", "Discover automatically, or enter one model per line.")}</span>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={!form.baseUrl.trim() || discovering}
                onClick={() => void discoverModels()}
              >
                {discovering ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Search size={14} />
                )}
                {tr("自动发现", "Discover")}
              </button>
            </div>
            <textarea
              className="provider-models-input"
              value={form.modelsText}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  modelsText: event.target.value,
                }))
              }
              placeholder={"gpt-5.2\nqwen3-coder\nmy-local-model"}
              spellCheck={false}
            />
            <div className="provider-detection-summary">
              <span>{tr("{count} 个模型", "{count} model(s)", { count: modelIds.length })}</span>
            </div>
            {error && <p className="api-key-error">{error}</p>}
          </div>
        </div>

        <div className="modal-footer api-key-footer">
          {editingProvider && !editingProvider.environmentKey ? (
            <button
              className="danger-text-button"
              type="button"
              disabled={saving}
              onClick={() => void removeCurrentProvider()}
            >
              <Trash2 size={14} />
              {tr("移除 Provider", "Remove provider")}
            </button>
          ) : (
            <span />
          )}
          <div className="modal-footer-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              {embedded ? tr("返回通用设置", "Back to General") : tr("关闭", "Close")}
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={
                !form.baseUrl.trim() ||
                !modelIds.length ||
                saving
              }
            >
              {saving && <LoaderCircle className="spin" size={14} />}
              {form.id ? tr("保存修改", "Save changes") : tr("添加 Provider", "Add provider")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ApplicationSettingsModal({
  initialSection = "general",
  theme,
  onThemeChange,
  providers,
  sandboxStatus,
  workspacePath = "",
  onProvidersChanged,
  onProviderSaved,
  onNotice,
  onClose,
}) {
  const { tr } = useI18n();
  const [section, setSection] = useState(initialSection);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop application-settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="application-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-settings-title"
      >
        <header className="application-settings-header">
          <div>
            <span className="application-settings-mark">
              <img src={APP_ICON_URL} alt="" aria-hidden="true" />
            </span>
            <div>
              <h2 id="application-settings-title">
                {tr("AporiaX 设置", "AporiaX Settings")}
              </h2>
              <p>{tr("应用偏好与本地能力", "Application preferences and local capabilities")}</p>
            </div>
          </div>
          <IconButton label={tr("关闭设置", "Close settings")} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>

        <div className="application-settings-body">
          <nav
            className="application-settings-nav"
            aria-label={tr("设置分类", "Settings sections")}
          >
            <button
              type="button"
              className={section === "general" ? "active" : ""}
              onClick={() => setSection("general")}
            >
              <Settings2 size={16} />
              {tr("通用", "General")}
            </button>
            <button
              type="button"
              className={section === "models" ? "active" : ""}
              onClick={() => setSection("models")}
            >
              <KeyRound size={16} />
              {tr("模型与 API", "Models & APIs")}
            </button>
            <button
              type="button"
              className={section === "extensions" ? "active" : ""}
              onClick={() => setSection("extensions")}
            >
              <Zap size={16} />
              {tr("扩展与能力", "Extensions")}
            </button>
            <button
              type="button"
              className={section === "about" ? "active" : ""}
              onClick={() => setSection("about")}
            >
              <Info size={16} />
              {tr("关于", "About")}
            </button>
          </nav>

          <main className={`application-settings-content ${section}-section`}>
            {section === "general" ? (
              <>
                <div className="application-settings-intro">
                  <span>{tr("通用", "General")}</span>
                  <h3>{tr("让 AporiaX 以你的方式工作。", "Make AporiaX work your way.")}</h3>
                </div>

                <section className="preference-card">
                  <div className="preference-card-heading">
                    <span>
                      <Languages size={17} />
                    </span>
                    <div>
                      <strong>{tr("界面语言", "Interface language")}</strong>
                      <p>
                        {tr(
                          "影响应用界面和之后生成的回复，不改写已有内容。",
                          "Applies to the interface and future replies without rewriting existing content.",
                        )}
                      </p>
                    </div>
                  </div>
                  <LanguageSwitch />
                </section>

                <section className="preference-card appearance-preference">
                  <div className="preference-card-heading">
                    <span>
                      <Palette size={17} />
                    </span>
                    <div>
                      <strong>{tr("外观", "Appearance")}</strong>
                      <p>{tr("选择适合当前环境的界面明暗。", "Choose the appearance that fits your environment.")}</p>
                    </div>
                  </div>
                  <div
                    className="appearance-options"
                    role="group"
                    aria-label={tr("外观主题", "Appearance theme")}
                  >
                    <button
                      type="button"
                      className={theme === "light" ? "active" : ""}
                      onClick={() => onThemeChange("light")}
                    >
                      <Sun size={16} />
                      <span>{tr("日间", "Light")}</span>
                      {theme === "light" && <Check size={14} />}
                    </button>
                    <button
                      type="button"
                      className={theme === "dark" ? "active" : ""}
                      onClick={() => onThemeChange("dark")}
                    >
                      <Moon size={16} />
                      <span>{tr("夜间", "Dark")}</span>
                      {theme === "dark" && <Check size={14} />}
                    </button>
                  </div>
                </section>

                <section className="preference-card">
                  <div className="preference-card-heading">
                    <span>
                      <Brain size={17} />
                    </span>
                    <div>
                      <strong>{tr("模型服务", "Model services")}</strong>
                      <p>
                        {providers.length
                          ? tr(
                              "已连接 {providers} 个 Provider，共 {models} 个模型。",
                              "{providers} provider(s) connected with {models} model(s).",
                              {
                                providers: providers.length,
                                models: providers.reduce(
                                  (count, provider) =>
                                    count + (provider.models?.length || 0),
                                  0,
                                ),
                              },
                            )
                          : tr(
                              "尚未添加模型 Provider。",
                              "No model provider has been added yet.",
                            )}
                      </p>
                    </div>
                  </div>
                  <button
                    className="preference-action"
                    type="button"
                    onClick={() => setSection("models")}
                  >
                    {tr("管理", "Manage")}
                    <ArrowRight size={14} />
                  </button>
                </section>

                <section className="preference-card">
                  <div className="preference-card-heading">
                    <span
                      className={
                        sandboxStatus?.available ||
                        sandboxStatus?.localAvailable
                          ? "ready"
                          : ""
                      }
                    >
                      <ShieldCheck size={17} />
                    </span>
                    <div>
                      <strong>{tr("本地执行边界", "Local execution boundary")}</strong>
                      <p>
                        {sandboxStatus?.available
                          ? tr(
                              "Docker 强隔离已就绪：默认断网、只读系统，仅工作区可写。",
                              "Docker strong isolation is ready: offline by default, read-only system, workspace-only writes.",
                            )
                          : tr(
                              "默认使用本地临时工作区自动执行。Docker 可有可无，仅用于加强系统级安全隔离。",
                              "Commands run automatically in a local temporary workspace. Docker is optional and only adds stronger system isolation.",
                            )}
                      </p>
                    </div>
                  </div>
                  <span className="preference-status">
                    {sandboxStatus?.available
                      ? tr("强隔离", "Strong isolation")
                      : tr("本地沙箱", "Local sandbox")}
                  </span>
                </section>
              </>
            ) : section === "models" ? (
              <ProviderManagerModal
                embedded
                providers={providers}
                onClose={() => setSection("general")}
                onChanged={onProvidersChanged}
                onSaved={onProviderSaved}
                onNotice={onNotice}
              />
            ) : section === "extensions" ? (
              <ExtensionsSettings
                workspacePath={workspacePath}
                onNotice={onNotice}
              />
            ) : (
              <section className="application-about">
                <span className="application-about-mark">
                  <img src={APP_ICON_URL} alt="" aria-hidden="true" />
                </span>
                <span className="application-about-kicker">AporiaX</span>
                <h3>Every problem begins with an aporia.</h3>
                <p>每个答案，都始于一个尚未解开的疑问。</p>
                <div className="application-about-principles">
                  <div>
                    <strong>Route</strong>
                    <span>{tr("看见行动路径", "See the path of action")}</span>
                  </div>
                  <div>
                    <strong>Evidence</strong>
                    <span>{tr("保留判断依据", "Preserve the evidence")}</span>
                  </div>
                  <div>
                    <strong>Anchor</strong>
                    <span>{tr("跨轮快照，安全回退", "Cross-turn snapshots, safe return")}</span>
                  </div>
                </div>
                <div className="application-author-credit">
                  <strong>
                    {tr(
                      "由 SeaLandX 设计与开发",
                      "Designed and built by SeaLandX",
                    )}
                  </strong>
                </div>
                <span className="application-preview-label">
                  {tr("本地优先 · Preview", "Local-first · Preview")}
                </span>
              </section>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

function App() {
  const { language, tr } = useI18n();
  const [tasks, setTasks] = useTaskStore(readSavedTasks);
  const [activeTaskId, setActiveTaskId] = useState(
    () => tasks[0]?.id || null,
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskProjectId, setNewTaskProjectId] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [completionNotice, setCompletionNotice] = useState(null);
  const [providers, setProviders] = useState([]);
  const [providersReady, setProvidersReady] = useState(false);
  const [resumeNewTaskAfterProvider, setResumeNewTaskAfterProvider] =
    useState(false);
  const [applicationSettingsOpen, setApplicationSettingsOpen] =
    useState(false);
  const [applicationSettingsSection, setApplicationSettingsSection] =
    useState("general");
  const [sandboxStatus, setSandboxStatus] = useState(null);
  const [sandboxPreparing, setSandboxPreparing] = useState(false);
  const [runningTaskIds, setRunningTaskIds] = useState(() => new Set());
  const [activeRunIdsByTask, setActiveRunIdsByTask] = useState({});
  const [pausedTaskIds, setPausedTaskIds] = useState(() => new Set());
  // Witness is now the visible, append-only run monitor. Keep the legacy
  // event branches inert until they are removed from the renderer protocol.
  const setRunStatus = () => {};
  const [approvalsByTask, setApprovalsByTask] = useState({});
  const [approvalResponding, setApprovalResponding] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [theme, setTheme] = useState(readSavedTheme);
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const runsRef = useRef(new Map());
  const tasksRef = useRef(tasks);

  const activeTask = tasks.find((task) => task.id === activeTaskId) || null;
  const projects = useMemo(() => buildWorkspaceProjects(tasks), [tasks]);
  const activeRunId = activeTaskId
    ? activeRunIdsByTask[activeTaskId] || null
    : null;
  const runPaused = activeTaskId ? pausedTaskIds.has(activeTaskId) : false;
  const approval = activeTaskId
    ? approvalsByTask[activeTaskId] || null
    : null;
  const setTaskPaused = (taskId, paused) => {
    if (!taskId) return;
    setPausedTaskIds((current) => {
      const next = new Set(current);
      if (paused) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };
  const setTaskApproval = (taskId, nextApproval) => {
    if (!taskId) return;
    setApprovalsByTask((current) => {
      const next = { ...current };
      if (nextApproval) next[taskId] = nextApproval;
      else delete next[taskId];
      return next;
    });
  };

  const openApplicationSettings = (section = "general") => {
    setApplicationSettingsSection(section);
    setApplicationSettingsOpen(true);
  };

  const requestNewTask = (projectId = "") => {
    const requestedProjectId =
      typeof projectId === "string"
        ? projectId
        : activeTask?.projectId || "";
    setNewTaskProjectId(
      requestedProjectId || activeTask?.projectId || "",
    );
    if (!providersReady) {
      setNotice(tr("正在加载模型配置，请稍候", "Loading model configuration"));
      return;
    }
    if (!getAvailableModels(providers).length) {
      setResumeNewTaskAfterProvider(true);
      setNewTaskOpen(false);
      openApplicationSettings("models");
      setNotice(
        tr(
          "先连接一个模型 API，保存后会继续创建任务",
          "Connect a model API first. Task creation will continue after you save it.",
        ),
      );
      return;
    }
    setResumeNewTaskAfterProvider(false);
    setNewTaskOpen(true);
  };

  const reloadProviders = async () => {
    if (!window.desktop?.providers?.list) {
      setProviders([]);
      setProvidersReady(true);
      return [];
    }
    try {
      const nextProviders = await window.desktop.providers.list();
      setProviders(nextProviders);
      return nextProviders;
    } finally {
      setProvidersReady(true);
    }
  };

  const refreshSandboxStatus = async () => {
    if (!window.desktop?.sandbox?.status) return null;
    try {
      const status = await window.desktop.sandbox.status();
      setSandboxStatus(status);
      return status;
    } catch (error) {
      const status = {
        available: false,
        state: "error",
        detail: cleanIpcError(error, tr("无法检测命令沙箱", "Unable to inspect the command sandbox")),
      };
      setSandboxStatus(status);
      return status;
    }
  };

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    // localStorage is only a startup cache. Serializing the entire task history
    // synchronously for every streamed token can block the renderer. Keep the
    // cache reasonably fresh without putting it on the hot response.delta path.
    const timeout = window.setTimeout(() => {
      cacheTasksLocally(tasks);
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [tasks]);

  useEffect(() => {
    localStorage.setItem(
      SIDEBAR_COLLAPSED_KEY,
      sidebarCollapsed ? "1" : "0",
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        theme === "dark" ? "#14191f" : "#eef3f7",
      );
    void window.desktop?.theme?.set(theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    const hydrateTasks = async () => {
      if (!window.desktop?.tasks) {
        if (active) setStorageReady(true);
        return;
      }
      try {
        const storedTasks = await window.desktop.tasks.load();
        if (!active) return;
        // The desktop JSON store is the durable authority once it exists.
        // Only a missing desktop file (null) may migrate the legacy startup
        // cache. An intentional durable [] must never resurrect stale cached
        // tasks.
        let hydratedTasks =
          storedTasks === null ? tasksRef.current : storedTasks;
        if (storedTasks === null && tasksRef.current.length > 0) {
          await window.desktop.tasks.save(tasksRef.current);
        }
        const recoverableRuns =
          (await window.desktop.harness?.recoverableRuns?.()) || [];
        hydratedTasks = normalizeTaskProjects(mergeRecoverableRuns(
          hydratedTasks || [],
          recoverableRuns,
          tr,
        ));
        if (!active) return;
        setTasks(hydratedTasks);
        setActiveTaskId(hydratedTasks[0]?.id || null);
        if (recoverableRuns.length) {
          setNotice(
            tr(
              "已恢复 {count} 个中断任务的检查点",
              "Recovered checkpoints for {count} interrupted task(s)",
              { count: recoverableRuns.length },
            ),
          );
        }
      } catch {
        if (active) setNotice(tr("任务历史加载失败，已使用本地缓存", "Task history failed to load; using the local cache"));
      } finally {
        if (active) setStorageReady(true);
      }
    };
    void hydrateTasks();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !window.desktop?.tasks) return undefined;
    const timeout = window.setTimeout(() => {
      void window.desktop.tasks.save(tasks).catch(() => {
        setNotice(tr("任务检查点保存失败", "Failed to save the task checkpoint"));
      });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [storageReady, tasks]);

  useEffect(() => {
    void reloadProviders().catch(() => {
      setProviders([]);
      setProvidersReady(true);
      setNotice(tr("模型 Provider 加载失败", "Failed to load model providers"));
    });
    void refreshSandboxStatus();
  }, []);

  useEffect(() => {
    if (!providersReady || !providers.length) return;
    setTasks((current) =>
      current.map((task) => {
        const selection = getModel(
          providers,
          task.providerId,
          task.modelId,
        );
        if (
          task.providerId === selection.providerId &&
          task.modelId === selection.id
        ) {
          return task;
        }
        return {
          ...task,
          providerId: selection.providerId,
          modelId: selection.id,
          thinking: selection.supportsThinking
            ? task.thinking
            : false,
        };
      }),
    );
  }, [providersReady, providers]);

  useHarnessEvents({
    language,
    tr,
    runsRef,
    setTasks,
    setRunPaused: setTaskPaused,
    setRunStatus,
    setSandboxStatus,
    setApproval: setTaskApproval,
    normalizeWorkspacePath,
  });

  useEffect(() => {
    if (!window.desktop?.notifications?.onTaskRequested) {
      return undefined;
    }
    return window.desktop.notifications.onTaskRequested(({ taskId }) => {
      if (!tasksRef.current.some((task) => task.id === taskId)) return;
      setActiveTaskId(taskId);
      setWelcomeOpen(false);
    });
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!completionNotice) return undefined;
    const timeout = window.setTimeout(
      () => setCompletionNotice(null),
      10_000,
    );
    return () => window.clearTimeout(timeout);
  }, [completionNotice]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        requestNewTask();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTask?.projectId, providers, providersReady, tr]);

  const updateActiveTask = (patch) => {
    const normalizedPatch =
      Object.prototype.hasOwnProperty.call(patch, "workspacePath")
        ? {
            ...patch,
            workspaceName:
              patch.workspaceName ||
              getFolderName(patch.workspacePath) ||
              tr("无工作区", "No workspace"),
            projectId: projectIdForWorkspace(patch.workspacePath),
          }
        : patch;
    setTasks((current) =>
      current.map((task) =>
        task.id === activeTaskId
          ? { ...task, ...normalizedPatch }
          : task,
      ),
    );
  };

  const renameTaskById = (taskId, title) => {
    const nextTitle = String(title || "").trim();
    if (!nextTitle) return false;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, title: nextTitle } : task,
      ),
    );
    setNotice(tr("任务已重命名", "Task renamed"));
    return true;
  };

  const createTask = (input) => {
    const task = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      messages: [],
      ...input,
      projectId:
        input.projectId || projectIdForWorkspace(input.workspacePath),
    };
    setTasks((current) => [task, ...current]);
    setActiveTaskId(task.id);
    setNewTaskOpen(false);
    setSettingsOpen(false);
    setNotice(tr("任务已创建", "Task created"));
  };

  const deleteTask = (taskId) => {
    if (runningTaskIds.has(taskId)) {
      setNotice(
        tr(
          "任务正在运行，请先停止任务再删除。",
          "This task is running. Stop it before deleting.",
        ),
      );
      return false;
    }
    const currentTasks = tasksRef.current;
    const taskIndex = currentTasks.findIndex((task) => task.id === taskId);
    if (taskIndex < 0) return false;
    const remainingTasks = currentTasks.filter((task) => task.id !== taskId);
    const nextActiveTask =
      remainingTasks[Math.min(taskIndex, remainingTasks.length - 1)] ||
      remainingTasks[0] ||
      null;
    setTasks(remainingTasks);
    setActiveTaskId((current) =>
      current === taskId ? nextActiveTask?.id || null : current,
    );
    setSettingsOpen(false);
    setNotice(tr("任务已删除，工作区文件保持不变", "Task deleted; workspace files were left unchanged"));
    return true;
  };

  const sendMessage = (content, attachments = [], request = {}) => {
    if (typeof window.desktop?.harness?.run !== "function") {
      setNotice(tr("请在 Electron 桌面端运行 Harness", "Run the Harness in the Electron desktop app"));
      return false;
    }
    if (!providers.length) {
      openApplicationSettings("models");
      setNotice(tr("请先添加一个模型 Provider", "Add a model provider first"));
      return false;
    }
    const targetTask = request.taskId
      ? tasksRef.current.find((task) => task.id === request.taskId)
      : activeTask;
    if (!targetTask) return false;
    const targetRunEntry = [...runsRef.current.entries()].find(
      ([, run]) => run.taskId === targetTask.id,
    );
    const targetRunId = targetRunEntry?.[0] || null;

    if (targetRunId && !request.force) {
      const createdAt = new Date().toISOString();
      if (
        window.desktop.harness.steer
      ) {
        const steeringMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content,
          attachments,
          steeringStatus: "pending",
          createdAt,
        };
        setTasks((current) =>
          current.map((task) =>
            task.id === targetTask.id
              ? {
                  ...task,
                  messages: [...task.messages, steeringMessage],
                }
              : task,
          ),
        );
        void window.desktop.harness
          .steer({
            runId: targetRunId,
            message: steeringMessage,
          })
          .then((accepted) => {
            if (accepted) return;
            throw new Error("The active run no longer accepts steering.");
          })
          .catch(() => {
            setTasks((current) =>
              current.map((task) =>
                task.id === targetTask.id
                  ? {
                      ...task,
                      messages: task.messages.map((message) =>
                        message.id === steeringMessage.id
                          ? {
                              ...message,
                              steeringStatus: "failed",
                              queued: true,
                              queuedAt: new Date().toISOString(),
                            }
                          : message,
                      ),
                    }
                  : task,
              ),
            );
            setNotice(
              tr(
                "即时纠偏未能接入，已自动转入下一轮队列",
                "Live steering could not be applied and was queued for the next turn",
              ),
            );
          });
        setNotice(
          tr(
            "新要求已发送，将在下一安全边界接入当前任务",
            "Guidance sent; it will join the current task at the next safe boundary",
          ),
        );
        return true;
      }
      const queuedMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        attachments,
        queued: true,
        queuedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      setTasks((current) =>
        current.map((task) =>
          task.id === targetTask.id
            ? {
                ...task,
                messages: [...task.messages, queuedMessage],
              }
            : task,
        ),
      );
      setNotice(
        tr(
          "追问已加入队列，当前任务结束后自动继续",
          "Follow-up queued and will run after the current task",
        ),
      );
      return true;
    }

    const runId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const retryAssistantId = request.retryAssistantId || "";
    const recoveryRunId = request.recoveryRunId || "";
    const retrySource = retryAssistantId
      ? targetTask.messages.find(
          (message) =>
            message.role === "user" &&
            message.id === request.retrySourceUserId,
        )
      : null;
    const queuedSource = request.userMessageId
      ? targetTask.messages.find(
          (message) =>
            message.id === request.userMessageId && message.queued,
        )
      : null;
    const userMessage = retrySource
      ? {
          ...retrySource,
          content: content || retrySource.content,
          attachments,
          retriedAt: new Date().toISOString(),
        }
      : queuedSource
      ? {
          ...queuedSource,
          queued: false,
          steeringStatus: null,
          startedAt: new Date().toISOString(),
        }
      : {
          id: crypto.randomUUID(),
          role: "user",
          content,
          attachments,
          createdAt: new Date().toISOString(),
        };
    const assistantMessage = {
      id: assistantId,
      role: "assistant",
      status: "running",
      content: "",
      prompt: userMessage.content,
      sourceUserId: userMessage.id,
      steps: [],
      changes: [],
      route: [
        {
          id: `${runId}-route-start`,
          stage: "route",
          title: tr("理解任务并准备行动", "Understand the task and prepare actions"),
          status: "running",
          startedAt: new Date().toISOString(),
        },
      ],
      witness: null,
      retryOfAssistantId: retryAssistantId || null,
      recoveryOfRunId: recoveryRunId || null,
      createdAt: new Date().toISOString(),
    };
    setTasks((current) =>
      current.map((task) =>
        task.id === targetTask.id
          ? {
              ...task,
              messages: retryAssistantId
                ? retrySource
                  ? replaceAssistantForRetry(
                      task,
                      retryAssistantId,
                      assistantMessage,
                    ).messages
                  : [
                      ...task.messages.filter(
                        (message) => message.id !== retryAssistantId,
                      ),
                      userMessage,
                      assistantMessage,
                    ]
                : queuedSource
                ? [
                    ...task.messages.map((message) =>
                      message.id === userMessage.id
                        ? userMessage
                        : message,
                    ),
                    assistantMessage,
                  ]
                : [
                    ...task.messages,
                    userMessage,
                    assistantMessage,
                  ],
            }
          : task,
      ),
    );
    runsRef.current.set(runId, {
      taskId: targetTask.id,
      assistantId,
      routeCounter: 0,
      approvalMode:
        targetTask.approvalMode === "manual"
          ? "manual"
          : "sandbox-auto",
    });
    setRunningTaskIds((current) => new Set(current).add(targetTask.id));
    setActiveRunIdsByTask((current) => ({
      ...current,
      [targetTask.id]: runId,
    }));
    setTaskPaused(targetTask.id, false);
    setTaskApproval(targetTask.id, null);
    setRunStatus({
      title: tr("正在启动 Harness", "Starting Harness"),
      detail: tr("正在加载项目指令与任务上下文", "Loading project instructions and task context"),
    });

    void Promise.resolve()
      .then(() => window.desktop.harness.run({
        runId,
        recoveryRunId: recoveryRunId || undefined,
        taskId: targetTask.id,
        assistantId,
        sourceUserId: userMessage.id,
        prompt: userMessage.content,
        workspacePath: targetTask.workspacePath,
        providerId: targetTask.providerId,
        modelId: targetTask.modelId,
        thinking: targetTask.thinking,
        effort: targetTask.effort,
        permission: targetTask.permission,
        approvalMode:
          targetTask.approvalMode === "manual"
            ? "manual"
            : "sandbox-auto",
        language,
        messages: [
          ...targetTask.messages.filter(
            (message) =>
              !message.queued &&
              !message.supersededByRetryId &&
              message.id !== userMessage.id &&
              message.id !== retryAssistantId,
          ),
          userMessage,
        ],
      }))
      .then((result) => {
        setTasks((current) =>
          current.map((task) =>
            task.id === targetTask.id
              ? {
                  ...task,
                  understandingRevision:
                    result.understanding?.currentRevision ||
                    task.understandingRevision ||
                    0,
                  messages: task.messages.map((message) =>
                    message.id === assistantId
                      ? {
                          ...message,
                          status: result.status || "completed",
                          error: Boolean(result.error),
                           content: result.content,
                          steps: result.steps || [],
                          changes: result.changes || [],
                          anchor: result.anchor || null,
                          route: enrichRouteEntries(
                             closeRunningRouteEntries(
                               message.route,
                               new Date().toISOString(),
                             ),
                             result.steps || [],
                             result,
                           ),
                          usage: result.usage || null,
                          instructionFiles:
                            result.instructionFiles || [],
                          permissionConfigFile:
                            result.permissionConfigFile || null,
                          provider:
                            result.provider || targetTask.providerId,
                          providerName:
                            result.providerName || "",
                          model: result.model || targetTask.modelId,
                          sandbox: result.sandbox || null,
                          tools: result.tools || [],
                          selfCheck: result.selfCheck || null,
                          understanding: result.understanding || null,
                          plan: result.plan || message.plan || null,
                          contextCheckpoints:
                            result.contextCheckpoints ||
                            message.contextCheckpoints ||
                            [],
                          witness:
                            result.witness || message.witness || null,
                          completedAt: new Date().toISOString(),
                        }
                      : message,
                  ),
                }
              : task,
          ),
        );
        if (result.status === "failed") {
          setNotice(tr("Harness 运行失败", "Harness run failed"));
        } else if (result.status === "interrupted") {
          setNotice(tr("任务已停止，已保留文件检查点", "Task stopped; file checkpoints were preserved"));
        } else if (result.status === "completed") {
          const summary = summarizeCompletionContent(
            result.content,
            tr(
              "任务已经完成，打开任务查看完整结果。",
              "The task is complete. Open it to view the full result.",
            ),
          );
          setCompletionNotice({
            taskId: targetTask.id,
            title: targetTask.title,
            summary,
          });
          void window.desktop?.notifications?.taskCompleted?.({
            taskId: targetTask.id,
            title: `AporiaX · ${targetTask.title}`,
            body: summary,
          });
        }
      })
      .catch((error) => {
        const cleanMessage = String(error?.message || tr("Harness 运行失败", "Harness run failed"))
          .replace(/^Error invoking remote method '[^']+':\s*/i, "")
          .replace(/^Error:\s*/i, "");
        setTasks((current) =>
          current.map((task) =>
            task.id === targetTask.id
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    message.id === assistantId
                      ? {
                          ...message,
                          status: "failed",
                          error: true,
                          content: cleanMessage,
                          route: (() => {
                            const route = closeRunningRouteEntries(
                              message.route,
                              new Date().toISOString(),
                            );
                            const lastIndex = route.length - 1;
                            if (lastIndex >= 0) {
                              route[lastIndex] = {
                                ...route[lastIndex],
                                status: "failed",
                              };
                            }
                            return enrichRouteEntries(
                              route,
                              message.steps || [],
                              {
                                status: "failed",
                                selfCheck: message.selfCheck,
                              },
                            );
                          })(),
                          completedAt: new Date().toISOString(),
                        }
                      : message,
                  ),
                }
              : task,
          ),
        );
        setNotice(tr("Harness 运行失败", "Harness run failed"));
      })
      .finally(() => {
        runsRef.current.delete(runId);
        setRunningTaskIds((current) => {
          const next = new Set(current);
          next.delete(targetTask.id);
          return next;
        });
        setActiveRunIdsByTask((current) => {
          if (current[targetTask.id] !== runId) return current;
          const next = { ...current };
          delete next[targetTask.id];
          return next;
        });
        setTaskPaused(targetTask.id, false);
        setApprovalsByTask((current) => {
          if (current[targetTask.id]?.runId !== runId) return current;
          const next = { ...current };
          delete next[targetTask.id];
          return next;
        });
        const nextQueued = tasksRef.current
          .filter((task) => task.id === targetTask.id)
          .flatMap((task) =>
            task.messages
              .filter(
                (message) =>
                  message.role === "user" &&
                  message.queued &&
                  message.id !== userMessage.id,
              )
              .map((message) => ({ taskId: task.id, message })),
          )
          .sort((left, right) =>
            String(left.message.queuedAt || left.message.createdAt).localeCompare(
              String(right.message.queuedAt || right.message.createdAt),
            ),
          )[0];
        if (nextQueued) {
          setRunStatus({
            title: tr("正在继续排队的追问", "Starting the queued follow-up"),
            detail: tr(
              "上一轮已结束，正在载入下一条问题",
              "The previous run finished; loading the next question",
            ),
          });
          window.setTimeout(() => {
            sendMessage("", [], {
              force: true,
              taskId: nextQueued.taskId,
              userMessageId: nextQueued.message.id,
            });
          }, 40);
        } else {
          setRunStatus(null);
        }
      });

    return true;
  };

  const stopActiveRun = async () => {
    if (!activeRunId || !window.desktop?.harness?.interrupt) return;
    setRunStatus({
      title: tr("正在停止任务", "Stopping task"),
      detail: tr("等待当前操作安全退出", "Waiting for the current operation to exit safely"),
    });
    if (activeTaskId) setTaskApproval(activeTaskId, null);
    try {
      await window.desktop.harness.interrupt(activeRunId);
    } catch {
      setNotice(tr("无法停止任务，请稍后重试", "Unable to stop the task. Try again shortly."));
    }
  };

  const pauseActiveRun = async () => {
    if (!activeRunId || !window.desktop?.harness?.pause) return;
    setRunStatus({
      title: tr("正在暂停任务", "Pausing task"),
      detail: tr(
        "等待当前模型请求或工具操作抵达安全边界",
        "Waiting for the current model request or tool action to reach a safe boundary",
      ),
    });
    try {
      const accepted = await window.desktop.harness.pause(activeRunId);
      if (!accepted) throw new Error("Run is no longer active.");
    } catch {
      setNotice(tr("无法暂停任务，请稍后重试", "Unable to pause the task. Try again shortly."));
    }
  };

  const resumeActiveRun = async () => {
    if (!activeRunId || !window.desktop?.harness?.resume) return;
    try {
      const accepted = await window.desktop.harness.resume(activeRunId);
      if (!accepted) throw new Error("Run is no longer active.");
    } catch {
      setNotice(tr("无法继续任务，请稍后重试", "Unable to resume the task. Try again shortly."));
    }
  };

  const respondToApproval = async (approved, scope = "once") => {
    if (!approval || !window.desktop?.harness?.respondToApproval) return;
    const currentApproval = approval;
    setApprovalResponding(true);
    try {
      const accepted = await window.desktop.harness.respondToApproval({
        runId: currentApproval.runId,
        approvalId: currentApproval.id,
        approved,
        scope,
      });
      if (!accepted) {
        setNotice(tr("审批请求已经失效", "The approval request has expired"));
        return;
      }
      setApprovalsByTask((current) => {
        if (current[currentApproval.taskId]?.id !== currentApproval.id) {
          return current;
        }
        const next = { ...current };
        delete next[currentApproval.taskId];
        return next;
      });
      setRunStatus({
        title: approved ? tr("操作已批准", "Action approved") : tr("操作已拒绝", "Action denied"),
        detail: approved
          ? tr("Harness 正在执行工具并收集结果", "Harness is running the tool and collecting results")
          : tr("Agent 会根据拒绝结果调整方案", "The agent will adjust its plan after the denial"),
      });
    } catch {
      setNotice(tr("无法提交审批结果", "Unable to submit the approval response"));
    } finally {
      setApprovalResponding(false);
    }
  };

  const retryMessage = async (assistantMessage) => {
    const task = tasksRef.current.find((candidate) =>
      candidate.messages.some(
        (message) => message.id === assistantMessage.id,
      ),
    );
    const sourceMessage = task?.messages.find(
      (message) => message.id === assistantMessage.sourceUserId,
    );
    const retryContent =
      assistantMessage.prompt || sourceMessage?.content || "";
    if (!task || (!retryContent.trim() && !sourceMessage?.attachments?.length)) {
      setNotice(
        tr(
          "找不到这一轮的原始请求，无法重试",
          "The original request for this turn is unavailable",
        ),
      );
      return false;
    }
    const taskRunEntry = [...runsRef.current.entries()].find(
      ([, run]) => run.taskId === task.id,
    );
    const taskRunId = taskRunEntry?.[0] || null;
    if (taskRunId) {
      if (!assistantMessage.recoverable || !window.desktop?.harness?.interrupt) {
        setNotice(
          tr(
            "请等待当前任务结束后再重试这一轮",
            "Wait for the current task to finish before retrying this turn",
          ),
        );
        return false;
      }
      setNotice(
        tr(
          "正在停止残留任务并准备恢复…",
          "Stopping the stale run before recovery…",
        ),
      );
      await window.desktop.harness.interrupt(taskRunId).catch(() => false);
      const deadline = Date.now() + 8_000;
      let stopped = false;
      while (Date.now() < deadline) {
        const localActive = [...runsRef.current.values()].some(
          (run) => run.taskId === task.id,
        );
        const mainRuns = window.desktop?.harness?.activeRuns
          ? await window.desktop.harness.activeRuns().catch(() => [])
          : [];
        const mainActive = mainRuns.some(
          (run) => run.runId === taskRunId || run.taskId === task.id,
        );
        if (!localActive && !mainActive) {
          stopped = true;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      }
      if (!stopped) {
        setNotice(
          tr(
            "旧任务仍在退出，请稍后再次点击恢复任务",
            "The previous run is still exiting. Try Resume task again shortly.",
          ),
        );
        return false;
      }
    }
    if (runningTaskIds.has(task.id)) {
      // A synchronous IPC/bridge failure in an older build could leave the
      // renderer marked as running even though no Harness run exists. Retrying
      // is also the recovery path for that stale state.
      setRunningTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
      setActiveRunIdsByTask((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setTaskPaused(task.id, false);
      setTaskApproval(task.id, null);
    }
    const retryRequest = {
      taskId: task.id,
      retryAssistantId: assistantMessage.id,
      retrySourceUserId: sourceMessage?.id || assistantMessage.sourceUserId,
      recoveryRunId: assistantMessage.recoverable?.runId || "",
    };
    const retryAttachments =
      sourceMessage?.attachments ||
      assistantMessage.inputAttachments ||
      [];
    const retryImages = retryAttachments.filter(isImageAttachment);
    if (
      retryImages.length &&
      !getModel(
        providers,
        task?.providerId,
        task?.modelId,
      ).supportsImages
    ) {
      setNotice(tr("当前模型不支持识图，已移除图片并按文字内容重试", "This model cannot read images. Images were removed before retrying the text."));
      return sendMessage(
        retryContent,
        retryAttachments.filter(
          (attachment) => !isImageAttachment(attachment),
        ),
        retryRequest,
      );
    }
    return sendMessage(
      retryContent,
      retryAttachments,
      retryRequest,
    );
  };

  const revertMessageChanges = async (messageId, paths) => {
    if (!window.desktop?.workspace?.revert) {
      setNotice(tr("桌面文件恢复能力不可用", "Desktop file recovery is unavailable"));
      return [];
    }
    const task = tasksRef.current.find((candidate) =>
      candidate.messages.some((message) => message.id === messageId),
    );
    const message = task?.messages.find(
      (candidate) => candidate.id === messageId,
    );
    if (!task?.workspacePath || !message?.changes?.length) {
      setNotice(tr("没有可恢复的文件检查点", "No restorable file checkpoint was found"));
      return [];
    }
    const pathSet = new Set(paths);
    const selectedChanges = message.changes.filter(
      (change) => pathSet.has(change.path) && !change.reverted,
    );
    if (!selectedChanges.length) return [];

    try {
      const results = await window.desktop.workspace.revert({
        workspacePath: task.workspacePath,
        changes: selectedChanges,
      });
      const revertedPaths = new Set(
        results
          .filter((result) => result.success)
          .map((result) => result.path),
      );
      setTasks((current) =>
        current.map((candidate) =>
          candidate.id === task.id
            ? {
                ...candidate,
                messages: candidate.messages.map((item) =>
                  item.id === messageId
                    ? {
                        ...item,
                        changes: item.changes.map((change) =>
                          revertedPaths.has(change.path)
                            ? { ...change, reverted: true }
                            : change,
                        ),
                      }
                    : item,
                ),
              }
            : candidate,
        ),
      );
      const conflicts = results.length - revertedPaths.size;
      if (conflicts > 0) {
        setNotice(tr(
          "已撤销 {count} 个文件，{conflicts} 个文件因后续改动未覆盖",
          "Reverted {count} file(s); {conflicts} file(s) were left intact because of later changes",
          { count: revertedPaths.size, conflicts },
        ));
      } else {
        setNotice(tr("已恢复 {count} 个文件检查点", "Restored {count} file checkpoint(s)", { count: revertedPaths.size }));
      }
      return results;
    } catch (error) {
      const cleanMessage = String(error?.message || tr("撤销失败", "Revert failed"))
        .replace(/^Error invoking remote method '[^']+':\s*/i, "")
        .replace(/^Error:\s*/i, "");
      setNotice(cleanMessage);
      return [];
    }
  };

  const restoreTaskToAnchor = async (
    taskId,
    anchorMessageId,
    restoreMode = "history",
  ) => {
    if (!window.desktop?.workspace?.restoreAnchor) {
      setNotice(
        tr(
          "桌面端跨轮恢复能力不可用",
          "Cross-turn restore is unavailable in this desktop build",
        ),
      );
      return { success: false, reason: "bridge-unavailable" };
    }
    if (runningTaskIds.has(taskId)) {
      setNotice(
        tr(
          "请先停止当前任务，再恢复 Anchor",
          "Stop the running task before restoring an Anchor",
        ),
      );
      return { success: false, reason: "task-running" };
    }

    const task = tasksRef.current.find(
      (candidate) => candidate.id === taskId,
    );
    const anchorMessages = (task?.messages || []).filter(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.changes) &&
        message.changes.length > 0,
    );
    const selectedIndex = anchorMessages.findIndex(
      (message) => message.id === anchorMessageId,
    );
    if (!task?.workspacePath || selectedIndex < 0) {
      setNotice(
        tr(
          "没有找到可恢复的跨轮快照",
          "No restorable cross-turn snapshot was found",
        ),
      );
      return { success: false, reason: "anchor-not-found" };
    }

    const targets = (restoreMode === "turn"
      ? anchorMessages.slice(selectedIndex, selectedIndex + 1)
      : anchorMessages.slice(selectedIndex)
    )
      .filter((message) =>
        message.changes.some((change) => !change.reverted),
      );
    const checkpoints = [...targets].reverse().map((message) => ({
      id: message.id,
      changes: message.changes.filter((change) => !change.reverted),
    }));
    if (!checkpoints.length) {
      return { success: false, reason: "anchor-already-restored" };
    }

    try {
      const result = await window.desktop.workspace.restoreAnchor({
        workspacePath: task.workspacePath,
        checkpoints,
      });
      if (!result?.success) {
        const firstConflict = result?.conflicts?.[0];
        setNotice(
          firstConflict?.path
            ? tr(
                "恢复已安全停止：{path} 在快照后又被修改",
                "Restore stopped safely: {path} changed after the snapshot",
                { path: firstConflict.path },
              )
            : tr(
                "Anchor 恢复未执行，工作区保持不变",
                "Anchor restore was not applied; the workspace is unchanged",
              ),
        );
        return result || { success: false };
      }

      const restoredIds = new Set(result.restoredCheckpoints || []);
      const restoredAt =
        result.restoredAt || new Date().toISOString();
      setTasks((current) =>
        current.map((candidate) =>
          candidate.id === taskId
            ? {
                ...candidate,
                anchorRestores: [
                  ...(candidate.anchorRestores || []).slice(-19),
                  {
                    id: crypto.randomUUID(),
                    anchorMessageId,
                    mode: restoreMode,
                    restoredAt,
                    restoredFiles: result.restoredFiles || 0,
                  },
                ],
                messages: candidate.messages.map((message) =>
                  restoredIds.has(message.id)
                    ? {
                        ...message,
                        anchorRestoredAt: restoredAt,
                        changes: message.changes.map((change) =>
                          change.reverted
                            ? change
                            : { ...change, reverted: true },
                        ),
                      }
                    : message,
                ),
              }
            : candidate,
        ),
      );
      setNotice(
        tr(
          "已恢复 {turns} 轮 Anchor，共还原 {files} 个文件",
          "Restored {turns} Anchor turn(s) across {files} file(s)",
          {
            turns: restoredIds.size,
            files: result.restoredFiles || 0,
          },
        ),
      );
      return result;
    } catch (error) {
      const cleanMessage = String(
        error?.message || tr("Anchor 恢复失败", "Anchor restore failed"),
      )
        .replace(/^Error invoking remote method '[^']+':\s*/i, "")
        .replace(/^Error:\s*/i, "");
      setNotice(cleanMessage);
      return { success: false, reason: "ipc-error" };
    }
  };

  const confirmMessageChanges = (messageId) => {
    const confirmedAt = new Date().toISOString();
    setTasks((current) =>
      current.map((task) => ({
        ...task,
        messages: task.messages.map((message) =>
          message.id === messageId
            ? { ...message, reviewConfirmedAt: confirmedAt }
            : message,
        ),
      })),
    );
    setNotice(tr("已确认保留上一轮修改", "Confirmed that the previous turn's changes should be kept"));
  };

  const saveReviewedMessageChange = (
    messageId,
    { path, content, savedAt },
  ) => {
    setTasks((current) =>
      current.map((task) => ({
        ...task,
        messages: task.messages.map((message) => {
          if (message.id !== messageId) return message;
          return {
            ...message,
            reviewConfirmedAt: null,
            changes: (message.changes || []).map((change) => {
              if (change.path !== path) return change;
              return {
                ...change,
                ...countChangedLines(change.beforeContent, content),
                afterContent: content,
                afterMissing: false,
                deleted: false,
                reverted: false,
                userEditedAt: savedAt || new Date().toISOString(),
              };
            }),
          };
        }),
      })),
    );
  };

  const prepareCommandSandbox = async () => {
    if (!window.desktop?.sandbox?.prepare || sandboxPreparing) return;
    setSandboxPreparing(true);
    setNotice(tr("正在准备可选的 Docker 强隔离镜像，首次构建可能需要几分钟", "Preparing the optional Docker strong-isolation image. The first build may take a few minutes."));
    try {
      const status = await window.desktop.sandbox.prepare();
      setSandboxStatus(status);
      setNotice(tr("Docker 强隔离已启用；本地沙箱仍可随时作为默认后备", "Docker strong isolation is enabled; the local sandbox remains available as the default fallback"));
    } catch (error) {
      setNotice(cleanIpcError(error, tr("沙箱准备失败", "Sandbox preparation failed")));
      await refreshSandboxStatus();
    } finally {
      setSandboxPreparing(false);
    }
  };

  const selectWorkspaceForActiveTask = async () => {
    if (!window.desktop?.selectDirectory) {
      setNotice(tr("桌面桥未加载，请关闭旧窗口后重新启动 Electron", "The desktop bridge is not loaded. Close the old window and restart Electron."));
      return;
    }
    try {
      const selectedPath = await window.desktop.selectDirectory();
      if (!selectedPath) return;
      updateActiveTask({
        workspacePath: selectedPath,
        workspaceName: getFolderName(selectedPath),
        permission: "workspace-write",
      });
      setNotice(tr("工作目录已绑定", "Workspace bound"));
    } catch {
      setNotice(tr("无法打开目录选择器，请重启 Electron", "Unable to open the folder picker. Restart Electron."));
    }
  };

  const dismissWelcome = () => {
    setWelcomeOpen(false);
  };

  return (
    <div className="app-shell" data-theme={theme}>
      <AppTitlebar onOpenSettings={() => openApplicationSettings("general")} />
      <div className="app-content">
        {!sidebarCollapsed && (
          <Sidebar
            tasks={tasks}
            activeTaskId={activeTaskId}
            onSelectTask={setActiveTaskId}
            onNewTask={requestNewTask}
            onRenameTask={renameTaskById}
            onDeleteTask={deleteTask}
            onNotice={setNotice}
            runningTaskIds={runningTaskIds}
            searchOpen={searchOpen}
            onToggleSearch={() => setSearchOpen((open) => !open)}
          />
        )}

        <section className="main-surface">
          {!activeTask && (
            <div className="surface-toolbar">
              <IconButton
                label={sidebarCollapsed ? tr("展开任务侧栏", "Expand task sidebar") : tr("收起任务侧栏", "Collapse task sidebar")}
                onClick={() => setSidebarCollapsed((current) => !current)}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen size={17} />
                ) : (
                  <PanelLeftClose size={17} />
                )}
              </IconButton>
              <span>{tr("工作区", "Workspace")}</span>
            </div>
          )}

          {activeTask ? (
            <TaskWorkspace
              task={activeTask}
              providers={providers}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() =>
                setSidebarCollapsed((current) => !current)
              }
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((open) => !open)}
              onSend={sendMessage}
              onStop={stopActiveRun}
              onPause={pauseActiveRun}
              onResume={resumeActiveRun}
              onRetry={retryMessage}
              onRevert={revertMessageChanges}
              onRestoreAnchor={(messageId) =>
                restoreTaskToAnchor(activeTask.id, messageId)
              }
              onRestoreTurnAnchor={(messageId) =>
                restoreTaskToAnchor(activeTask.id, messageId, "turn")
              }
              onConfirmChanges={confirmMessageChanges}
              onSaveChanges={saveReviewedMessageChange}
              approval={
                approval?.taskId === activeTask.id ? approval : null
              }
              approvalResponding={approvalResponding}
              onRespondApproval={respondToApproval}
              onUpdateTask={updateActiveTask}
              isRunning={runningTaskIds.has(activeTask.id)}
              isPaused={runningTaskIds.has(activeTask.id) && runPaused}
              onManageProviders={() => openApplicationSettings("models")}
              sandboxStatus={sandboxStatus}
              sandboxPreparing={sandboxPreparing}
              onPrepareSandbox={() => void prepareCommandSandbox()}
              onSelectWorkspace={selectWorkspaceForActiveTask}
              onNotice={setNotice}
              onDeleteTask={deleteTask}
              theme={theme}
              onToggleTheme={() =>
                setTheme((current) =>
                  current === "dark" ? "light" : "dark",
                )
              }
            />
          ) : (
            <EmptyState onNewTask={requestNewTask} />
          )}
        </section>
      </div>

      {newTaskOpen && (
        <NewTaskModal
          providers={providers}
          projects={projects}
          initialProjectId={newTaskProjectId}
          onClose={() => setNewTaskOpen(false)}
          onCreate={createTask}
          onNotice={setNotice}
        />
      )}
      {applicationSettingsOpen && (
        <ApplicationSettingsModal
          initialSection={applicationSettingsSection}
          theme={theme}
          onThemeChange={setTheme}
          providers={providers}
          sandboxStatus={sandboxStatus}
          workspacePath={activeTask?.workspacePath || ""}
          onProvidersChanged={reloadProviders}
          onProviderSaved={({ providers: nextProviders }) => {
            if (
              resumeNewTaskAfterProvider &&
              getAvailableModels(nextProviders).length
            ) {
              setResumeNewTaskAfterProvider(false);
              setApplicationSettingsOpen(false);
              setNewTaskOpen(true);
              setNotice(
                tr(
                  "模型已连接，现在选择工作目录",
                  "The model is connected. Now choose a workspace.",
                ),
              );
            }
          }}
          onNotice={setNotice}
          onClose={() => {
            setApplicationSettingsOpen(false);
            setResumeNewTaskAfterProvider(false);
          }}
        />
      )}
      {welcomeOpen && <WelcomeOverlay onContinue={dismissWelcome} />}
      <TaskCompletionToast
        notification={completionNotice}
        onClose={() => setCompletionNotice(null)}
        onOpen={() => {
          if (completionNotice?.taskId) {
            setActiveTaskId(completionNotice.taskId);
            setWelcomeOpen(false);
          }
          setCompletionNotice(null);
        }}
      />
      <Toast message={notice} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
