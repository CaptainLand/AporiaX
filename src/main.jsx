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
  Copy,
  Ellipsis,
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
  closeRunningRouteEntries,
  collectTaskRouteRuns,
  enrichRouteEntries,
  formatRouteDuration,
  getDeliverableType,
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
import "./styles.css";

const STORAGE_KEY = "aporiax.tasks.v1";
const SIDEBAR_COLLAPSED_KEY = "aporiax.sidebar-collapsed.v1";
const SETTINGS_PANEL_WIDTH_KEY = "aporiax.settings-panel-width.v1";
const FILES_PANEL_WIDTH_KEY = "aporiax.files-panel-width.v1";
const THEME_STORAGE_KEY = "aporiax.theme.v1";
const DEFAULT_SETTINGS_PANEL_WIDTH = 320;
const DEFAULT_FILES_PANEL_WIDTH = 520;

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

const EMPTY_MODEL = {
  id: "",
  providerId: "",
  providerName: "未配置 Provider",
  name: "未配置模型",
  shortName: "未配置",
  description: "请先添加模型 API",
  descriptionZh: "请先添加模型 API",
  descriptionEn: "Add a model API to begin",
  supportsImages: false,
  supportsThinking: false,
  supportsTools: false,
  icon: Brain,
};

const DEFAULT_TASK_OPTIONS = {
  thinking: true,
  effort: "high",
  permission: "workspace-write",
  approvalMode: "sandbox-auto",
};

function readSavedTasks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function createLightweightTaskCache(tasks) {
  return (tasks || []).map((task) => ({
    ...task,
    anchorRestores: (task.anchorRestores || []).slice(-10),
    messages: (task.messages || []).slice(-50).map((message) => ({
      ...message,
      content: String(message.content || "").slice(-60_000),
      changes: [],
      anchor: message.anchor
        ? {
            ...message.anchor,
            warning:
              "Snapshot payload is stored in the desktop task history.",
          }
        : null,
      attachments: (message.attachments || []).map((attachment) => ({
        ...attachment,
        dataUrl: undefined,
        data: undefined,
        content: String(attachment.content || "").slice(0, 20_000),
      })),
    })),
  }));
}

function cacheTasksLocally(tasks) {
  const serialized = JSON.stringify(tasks);
  try {
    if (new Blob([serialized]).size <= 3_500_000) {
      localStorage.setItem(STORAGE_KEY, serialized);
      return;
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(createLightweightTaskCache(tasks)),
    );
  } catch {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(createLightweightTaskCache(tasks).slice(0, 20)),
      );
    } catch {
      // The desktop JSON store remains authoritative when browser quota is full.
    }
  }
}

function getFolderName(folderPath) {
  if (!folderPath) return "";
  const parts = folderPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || folderPath;
}

function getAvailableModels(providers) {
  return (providers || []).flatMap((provider) =>
    (provider.models || []).map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.name,
      description: [
        provider.name,
        model.supportsImages ? "支持图片" : "仅文本",
        model.supportsTools === false ? "不支持工具" : "支持工具",
      ].join(" · "),
      descriptionZh: [
        provider.name,
        model.supportsImages ? "支持图片" : "仅文本",
        model.supportsTools === false ? "不支持工具" : "支持工具",
      ].join(" · "),
      descriptionEn: [
        provider.name,
        model.supportsImages ? "Vision" : "Text only",
        model.supportsTools === false ? "No tools" : "Tool use",
      ].join(" · "),
      icon: model.supportsThinking ? Brain : Zap,
    })),
  );
}

function getModel(providers, providerId, modelId) {
  const models = getAvailableModels(providers);
  return (
    models.find(
      (model) =>
        model.providerId === providerId && model.id === modelId,
    ) ||
    models.find((model) => model.id === modelId) ||
    models[0] ||
    EMPTY_MODEL
  );
}

function getDefaultTaskConfig(providers) {
  const model = getAvailableModels(providers)[0] || EMPTY_MODEL;
  return {
    ...DEFAULT_TASK_OPTIONS,
    thinking: Boolean(model.supportsThinking),
    providerId: model.providerId || "",
    modelId: model.id || "",
  };
}

function IconButton({ label, className = "", children, ...props }) {
  return (
    <button
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
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
        <div className="brand-mark">
          <span>A</span>
          <i>X</i>
        </div>
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
  runningTaskId,
  searchOpen,
  onToggleSearch,
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTask, setRenameTask] = useState(null);
  const [deleteTask, setDeleteTask] = useState(null);
  const searchRef = useRef(null);
  const contextMenuRef = useRef(null);
  const filteredTasks = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return tasks;
    return tasks.filter((task) =>
      `${task.title} ${task.workspaceName}`.toLowerCase().includes(keyword),
    );
  }, [query, tasks]);

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
          <span>{tr("任务", "Tasks")}</span>
          <IconButton label={tr("搜索任务", "Search tasks")} onClick={onToggleSearch}>
            <Search size={16} />
          </IconButton>
        </div>

        <button className="new-task-button" onClick={onNewTask}>
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
              placeholder={tr("搜索任务", "Search tasks")}
              aria-label={tr("搜索任务", "Search tasks")}
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
        <div className="section-label">{tr("最近任务", "Recent tasks")}</div>
        {filteredTasks.length ? (
          filteredTasks.map((task) => (
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
              <MessageSquare size={15} />
              <span className="task-item-copy">
                <span className="task-item-title">{task.title}</span>
                <span className="task-item-workspace">{task.workspaceName}</span>
              </span>
            </button>
          ))
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
            disabled={runningTaskId === contextTask.id}
            onClick={() => {
              setDeleteTask(contextTask);
              setContextMenu(null);
            }}
          >
            <Trash2 size={15} />
            {runningTaskId === contextTask.id
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

function ModelChoice({ model, selected, onSelect, compact = false }) {
  const { tr } = useI18n();
  const ModelIcon = model.icon;

  return (
    <button
      className={`model-choice ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      onClick={() => onSelect(model)}
      type="button"
    >
      <span className="model-choice-icon">
        <ModelIcon size={17} />
      </span>
      <span className="model-choice-copy">
        <span className="model-choice-name">{model.name}</span>
        {!compact && <code className="model-choice-id">{model.id}</code>}
        <small>{tr(model.descriptionZh || model.description, model.descriptionEn || model.description)}</small>
      </span>
      {selected && <Check size={17} className="model-choice-check" />}
    </button>
  );
}

function Switch({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SegmentedControl({ value, onChange, options, ariaLabel }) {
  return (
    <div className="segmented-control" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NewTaskModal({
  providers,
  onClose,
  onCreate,
  onNotice,
}) {
  const { tr } = useI18n();
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
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
          setWorkspacePath(selectedPath);
          setWorkspaceName(result?.name || getFolderName(selectedPath));
          setTimeout(() => titleRef.current?.focus(), 0);
        }
        return;
      }

      if (window.showDirectoryPicker) {
        const handle = await window.showDirectoryPicker();
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
          <section className="form-section">
            <label className="field-label">{tr("工作目录", "Workspace")}</label>
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

function ModelMenu({ task, providers, onUpdate, onClose }) {
  const { tr } = useI18n();
  const menuRef = useRef(null);
  const selectedModel = getModel(
    providers,
    task.providerId,
    task.modelId,
  );

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="model-menu" ref={menuRef}>
      <div className="model-menu-heading">{tr("选择模型", "Choose a model")}</div>
      <div className="model-menu-options">
        {getAvailableModels(providers).map((model) => (
          <ModelChoice
            key={`${model.providerId}:${model.id}`}
            compact
            model={model}
            selected={
              task.providerId === model.providerId &&
              task.modelId === model.id
            }
            onSelect={(selection) =>
              onUpdate({
                providerId: selection.providerId,
                modelId: selection.id,
                thinking: selection.supportsThinking
                  ? task.thinking
                  : false,
              })
            }
          />
        ))}
      </div>
      <div className="model-menu-divider" />
      <div className="model-menu-row">
        <div>
          <span className="model-menu-label">{tr("深度思考", "Deep thinking")}</span>
          <small>{tr("先规划再执行", "Plan before acting")}</small>
        </div>
        <Switch
          checked={task.thinking}
          label={tr("深度思考", "Deep thinking")}
          disabled={!selectedModel.supportsThinking}
          onChange={(thinking) => onUpdate({ thinking })}
        />
      </div>
      {task.thinking && (
        <div className="model-menu-row">
          <span className="model-menu-label">{tr("思考强度", "Reasoning effort")}</span>
          <SegmentedControl
            value={task.effort}
            ariaLabel={tr("思考强度", "Reasoning effort")}
            options={[
              { value: "high", label: "High" },
              { value: "max", label: "Max" },
            ]}
            onChange={(effort) => onUpdate({ effort })}
          />
        </div>
      )}
    </div>
  );
}

function readImageFile(file) {
  return new Promise((resolveImage, rejectImage) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolveImage({
        id: crypto.randomUUID(),
        kind: "image",
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: String(reader.result),
      });
    reader.onerror = () =>
      rejectImage(new Error(`无法读取图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

const DOCUMENT_ATTACHMENT_ACCEPT = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".vue",
  ".svelte",
  ".sql",
  ".sh",
  ".ps1",
  ".toml",
  ".ini",
  ".log",
].join(",");

function isImageAttachment(attachment) {
  return (
    attachment?.kind === "image" ||
    typeof attachment?.dataUrl === "string"
  );
}

function formatAttachmentSize(size) {
  if (!Number.isFinite(size)) return "";
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${(size / 1_000).toFixed(1)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

function Composer({
  task,
  providers,
  onSend,
  onStop,
  onPause,
  onResume,
  onUpdateTask,
  onNotice,
  isRunning,
  isPaused,
  queuedCount = 0,
  pendingSteeringCount = 0,
}) {
  const { tr } = useI18n();
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const model = getModel(
    providers,
    task.providerId,
    task.modelId,
  );

  const send = () => {
    const content = message.trim();
    if (
      (!content && !attachments.length) ||
      attachmentLoading
    ) {
      return;
    }
    if (attachments.some(isImageAttachment) && !model.supportsImages) {
      onNotice(tr(
        "{model} 当前仅支持文字，不能读取图片",
        "{model} is text-only and cannot read images",
        { model: model.shortName },
      ));
      return;
    }
    const accepted = onSend(content, attachments);
    if (accepted === false) return;
    setMessage("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const addImageFiles = async (fileList) => {
    if (!model.supportsImages) {
      onNotice(tr(
        "{model} 当前仅支持文字；识图需要接入视觉模型或 OCR",
        "{model} is text-only; image understanding requires a vision model or OCR",
        { model: model.shortName },
      ));
      return;
    }
    const imageCount = attachments.filter(isImageAttachment).length;
    const remaining = Math.max(
      0,
      Math.min(4 - imageCount, 6 - attachments.length),
    );
    const candidates = [...(fileList || [])]
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, remaining);
    if (!candidates.length) return;
    const oversized = candidates.find((file) => file.size > 8_000_000);
    if (oversized) {
      onNotice(tr("图片不能超过 8 MB：{name}", "Images cannot exceed 8 MB: {name}", { name: oversized.name }));
      return;
    }
    try {
      const images = await Promise.all(candidates.map(readImageFile));
      setAttachments((current) => [...current, ...images].slice(0, 6));
    } catch (error) {
      onNotice(error?.message || tr("无法读取图片", "Unable to read the image"));
    }
  };

  const addDocumentFiles = async (fileList) => {
    if (!window.desktop?.attachments?.parse) {
      onNotice(tr("附件解析能力不可用，请重启 AporiaX 桌面端", "Attachment parsing is unavailable. Restart AporiaX."));
      return;
    }
    const remaining = Math.max(0, 6 - attachments.length);
    const candidates = [...(fileList || [])]
      .filter((file) => !file.type.startsWith("image/"))
      .slice(0, remaining);
    if (!candidates.length) {
      if (remaining === 0) onNotice(tr("每条消息最多添加 6 个附件", "Each message can include up to 6 attachments"));
      return;
    }
    const oversized = candidates.find((file) => file.size > 8_000_000);
    if (oversized) {
      onNotice(tr("附件不能超过 8 MB：{name}", "Attachments cannot exceed 8 MB: {name}", { name: oversized.name }));
      return;
    }
    setAttachmentLoading(true);
    try {
      const parsed = [];
      for (const file of candidates) {
        const result = await window.desktop.attachments.parse({
          name: file.name,
          type: file.type,
          data: new Uint8Array(await file.arrayBuffer()),
        });
        parsed.push({
          ...result,
          id: crypto.randomUUID(),
          kind: "document",
        });
      }
      setAttachments((current) => [...current, ...parsed].slice(0, 6));
      const ocrCount = parsed.filter(
        (attachment) => attachment.requiresOcr,
      ).length;
      onNotice(
        ocrCount
          ? tr(
              "已解析 {count} 个附件，其中 {ocr} 个 PDF 可能需要 OCR",
              "Parsed {count} attachments; {ocr} PDF file(s) may require OCR",
              { count: parsed.length, ocr: ocrCount },
            )
          : tr("已解析 {count} 个附件", "Parsed {count} attachment(s)", { count: parsed.length }),
      );
    } catch (error) {
      const cleanMessage = String(error?.message || tr("无法解析附件", "Unable to parse the attachment"))
        .replace(/^Error invoking remote method '[^']+':\s*/i, "")
        .replace(/^Error:\s*/i, "");
      onNotice(cleanMessage);
    } finally {
      setAttachmentLoading(false);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const handlePaste = (event) => {
    const images = [...(event.clipboardData?.files || [])].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!images.length) return;
    event.preventDefault();
    void addImageFiles(images);
  };

  const resizeTextarea = (event) => {
    setMessage(event.target.value);
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 156)}px`;
  };

  return (
    <div
      className="composer-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const dropped = [...event.dataTransfer.files];
        const images = dropped.filter((file) =>
          file.type.startsWith("image/"),
        );
        const documents = dropped.filter(
          (file) => !file.type.startsWith("image/"),
        );
        if (images.length) void addImageFiles(images);
        if (documents.length) void addDocumentFiles(documents);
      }}
    >
      <div className="composer">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) =>
              attachment.kind === "document" ? (
                <div
                  className="composer-document-attachment"
                  key={attachment.id}
                >
                  <span className="composer-document-icon">
                    <FileText size={17} />
                  </span>
                  <span className="composer-document-copy">
                    <strong>{attachment.name}</strong>
                    <small>
                      {attachment.format || tr("文件", "File")}
                      {Number.isInteger(attachment.pageCount)
                        ? tr(" · {count} 页", " · {count} pages", { count: attachment.pageCount })
                        : ""}
                      {attachment.requiresOcr
                        ? tr(" · 需要 OCR", " · OCR required")
                        : ` · ${formatAttachmentSize(attachment.size)}`}
                    </small>
                  </span>
                  <button
                    type="button"
                    aria-label={tr("移除 {name}", "Remove {name}", { name: attachment.name })}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter(
                          (item) => item.id !== attachment.id,
                        ),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <figure key={attachment.id}>
                  <img src={attachment.dataUrl} alt={attachment.name} />
                  <figcaption>{attachment.name}</figcaption>
                  <button
                    type="button"
                    aria-label={tr("移除 {name}", "Remove {name}", { name: attachment.name })}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter(
                          (item) => item.id !== attachment.id,
                        ),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </figure>
              ),
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={resizeTextarea}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={tr("描述你想完成的任务", "Describe what you want to accomplish")}
          rows={1}
          aria-label={tr("任务输入", "Task prompt")}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                void addImageFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={attachmentInputRef}
              type="file"
              accept={DOCUMENT_ATTACHMENT_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                void addDocumentFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              className={`composer-add ${!model.supportsImages ? "unsupported" : ""}`}
              aria-label={
                model.supportsImages
                  ? tr("添加图片", "Add image")
                  : tr("当前模型不支持图片", "This model does not support images")
              }
              title={
                model.supportsImages
                  ? tr("添加图片", "Add image")
                  : tr("当前模型仅支持文字，识图需要视觉模型或 OCR", "This model is text-only; image understanding requires vision or OCR")
              }
              type="button"
              onClick={() => {
                if (!model.supportsImages) {
                  onNotice(
                    tr(
                      "{model} 当前仅支持文字；识图需要接入视觉模型或 OCR",
                      "{model} is text-only; image understanding requires a vision model or OCR",
                      { model: model.shortName },
                    ),
                  );
                  return;
                }
                imageInputRef.current?.click();
              }}
            >
              <ImagePlus size={17} />
            </button>
            <button
              className="composer-add composer-file-add"
              aria-label={tr("添加附件", "Add attachment")}
              title={tr("添加附件（PDF、Office、Markdown、文本或代码）", "Add PDF, Office, Markdown, text, or code files")}
              type="button"
              disabled={attachmentLoading}
              onClick={() => attachmentInputRef.current?.click()}
            >
              {attachmentLoading ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Plus size={17} />
              )}
            </button>
            <div className="model-control">
              {modelMenuOpen && (
                <ModelMenu
                  task={task}
                  providers={providers}
                  onClose={() => setModelMenuOpen(false)}
                  onUpdate={(patch) => onUpdateTask(patch)}
                />
              )}
              <button
                className={`model-trigger ${modelMenuOpen ? "active" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setModelMenuOpen((open) => !open);
                }}
              >
                <model.icon size={15} />
                <span>{model.shortName}</span>
                {task.thinking && (
                  <span className="thinking-pill">{task.effort}</span>
                )}
                <ChevronDown size={14} />
              </button>
            </div>
          </div>
          <div className="composer-run-actions">
            {isRunning && (
              <>
                <button
                  className="composer-pause-button"
                  type="button"
                  aria-label={
                    isPaused
                      ? tr("继续当前任务", "Resume current task")
                      : tr("暂停当前任务", "Pause current task")
                  }
                  title={
                    isPaused
                      ? tr("继续当前任务", "Resume current task")
                      : tr("在安全边界暂停", "Pause at a safe boundary")
                  }
                  onClick={isPaused ? onResume : onPause}
                >
                  {isPaused ? (
                    <Play size={13} fill="currentColor" />
                  ) : (
                    <Pause size={13} fill="currentColor" />
                  )}
                </button>
                <button
                  className="composer-stop-button"
                  type="button"
                  aria-label={tr("停止当前任务", "Stop current task")}
                  title={tr("停止当前任务", "Stop current task")}
                  onClick={onStop}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              </>
            )}
            <button
              className="send-button"
              aria-label={
                isRunning
                  ? tr("发送追问", "Queue follow-up")
                  : tr("发送", "Send")
              }
              title={
                isRunning
                  ? tr("发送追问", "Queue follow-up")
                  : tr("发送", "Send")
              }
              disabled={
                attachmentLoading ||
                (!message.trim() && !attachments.length)
              }
              onClick={send}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
      <p className="composer-hint">
        {isRunning
          ? isPaused
            ? tr(
                "任务已暂停 · 可以继续补充要求，恢复后会应用",
                "Task paused · add guidance now; it will apply after resume",
              )
            : pendingSteeringCount > 0
              ? tr(
                  "任务运行中 · {count} 条新要求将在下一安全边界应用",
                  "Task running · {count} instruction(s) will apply at the next safe boundary",
                  { count: pendingSteeringCount },
                )
              : queuedCount > 0
            ? tr(
                "当前任务运行中 · {count} 条追问已排队",
                "Task running · {count} follow-up(s) queued",
                { count: queuedCount },
              )
            : tr(
                "任务运行中 · 可以继续纠偏，新要求会在安全边界立即接入",
                "Task running · keep steering; new guidance is applied at a safe boundary",
              )
          : model.supportsImages
            ? tr("Enter 发送 · Shift Enter 换行 · 可添加图片、PDF、文档与代码", "Enter to send · Shift Enter for a new line · Add images, PDFs, documents, and code")
            : tr("Enter 发送 · Shift Enter 换行 · 可添加 PDF、文档与代码附件", "Enter to send · Shift Enter for a new line · Add PDFs, documents, and code")}
      </p>
    </div>
  );
}

function MarkdownCodeBlock({ children }) {
  const { tr } = useI18n();
  const [copied, setCopied] = useState(false);
  const codeElement = React.Children.toArray(children)[0];
  const className = codeElement?.props?.className || "";
  const language = className.startsWith("language-")
    ? className.slice("language-".length)
    : "text";
  const code = String(codeElement?.props?.children || "").replace(/\n$/, "");

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span>{language}</span>
        <button onClick={copyCode} type="button">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? tr("已复制", "Copied") : tr("复制", "Copy")}
        </button>
      </div>
      <pre>
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownMessage({ content }) {
  const normalizedContent = String(content || "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(
      /!\[[^\]]*\]\((?:data:image\/svg\+xml|[^)\s]+\.svg)[^)]*\)/gi,
      "",
    )
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: MarkdownCodeBlock,
          a: ({ children, ...props }) => (
            <a {...props} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

function FileIcon({ path }) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const codeExtensions = new Set([
    "js",
    "jsx",
    "ts",
    "tsx",
    "py",
    "java",
    "c",
    "cpp",
    "cs",
    "go",
    "rs",
    "vue",
    "html",
    "css",
    "json",
  ]);

  return codeExtensions.has(extension) ? (
    <FileCode2 size={15} />
  ) : (
    <FileText size={15} />
  );
}

function extractLegacyFilePaths(content) {
  const files = [];
  let currentFolder = "";

  for (const line of String(content || "").split(/\r?\n/)) {
    const folderMatch = line.match(
      /^#{1,6}\s+(?:📁\s*)?`?([^`|—]+\/)`?(?:\s*—|$)/,
    );
    if (folderMatch) {
      currentFolder = folderMatch[1].trim();
      continue;
    }

    if (!line.trim().startsWith("|")) continue;
    const firstCell = line
      .split("|")[1]
      ?.trim()
      .replace(/^`|`$/g, "")
      .replace(/\*\*/g, "");
    if (
      !firstCell ||
      firstCell === "文件" ||
      /^:?-{3,}:?$/.test(firstCell) ||
      !/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/.test(firstCell)
    ) {
      continue;
    }

    const path = firstCell.includes("/")
      ? firstCell
      : `${currentFolder}${firstCell}`;
    if (!files.includes(path)) files.push(path);
  }

  return files;
}

function collectEditedFiles(steps, content, changes) {
  if (Array.isArray(changes) && changes.length > 0) {
    return changes.map((change) => ({
      path: change.path,
      additions: Number(change.additions) || 0,
      deletions: Number(change.deletions) || 0,
      binary: Boolean(change.binary),
      artifact: change.artifact || null,
      created: Boolean(change.created),
      deleted: Boolean(change.deleted || change.afterMissing),
      reverted: Boolean(change.reverted),
      legacy: false,
    }));
  }

  const grouped = new Map();
  const successfulWrites = (steps || []).filter(
    (step) => step.name === "write_file" && step.success,
  );

  for (const step of successfulWrites) {
    if (!step.path) continue;
    const current = grouped.get(step.path) || {
      path: step.path,
      additions: 0,
      deletions: 0,
      created: false,
      legacy: false,
    };
    current.additions += Number(step.additions) || 0;
    current.deletions += Number(step.deletions) || 0;
    current.created = current.created || Boolean(step.created);
    grouped.set(step.path, current);
  }

  if (grouped.size > 0) return [...grouped.values()];

  return extractLegacyFilePaths(content)
    .slice(0, successfulWrites.length)
    .map((path) => ({
      path,
      additions: null,
      deletions: null,
      created: true,
      legacy: true,
    }));
}

function countChangedLines(beforeContent, afterContent) {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(
    String(beforeContent || ""),
    String(afterContent || ""),
  )) {
    const count =
      Number(part.count) ||
      Math.max(1, String(part.value || "").split(/\r?\n/).length - 1);
    if (part.added) additions += count;
    if (part.removed) deletions += count;
  }
  return { additions, deletions };
}

function EditedFilesCard({
  files,
  hasSnapshots,
  confirmed,
  onReview,
}) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return null;

  const hasLineStats = files.some(
    (file) => !file.legacy && !file.binary,
  );
  const officeFiles = files.filter((file) => file.binary);
  const additions = files.reduce(
    (total, file) => total + (Number(file.additions) || 0),
    0,
  );
  const deletions = files.reduce(
    (total, file) => total + (Number(file.deletions) || 0),
    0,
  );
  const visibleFiles = expanded ? files : files.slice(0, 3);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <section className="edited-files-card">
      <div className="edited-files-header">
        <div className="edited-files-title">
          <span className="edited-files-icon">
            <Files size={17} />
          </span>
          <div>
            <strong>{tr("已编辑 {count} 个文件", "Edited {count} file(s)", { count: files.length })}</strong>
            {hasLineStats ? (
              <span>
                <b className="diff-add">+{additions}</b>
                <b className="diff-delete">-{deletions}</b>
              </span>
            ) : (
              <span className="legacy-edit-note">
                {officeFiles.length
                  ? tr(
                      "{count} 个 Office 工件 · 可审核撤销",
                      "{count} Office artifact(s) · reviewable and reversible",
                      { count: officeFiles.length },
                    )
                  : tr("历史记录 · 无行数统计", "Historical record · no line statistics")}
              </span>
            )}
          </div>
        </div>
        <div className="edited-files-actions">
          {confirmed && (
            <span className="edited-files-confirmed">
              <Check size={12} />
              {tr("已确认", "Confirmed")}
            </span>
          )}
          <button
            className="review-files-button"
            type="button"
            onClick={() =>
              hasSnapshots
                ? onReview(null)
                : setExpanded((open) => !open)
            }
          >
            {hasSnapshots
              ? tr("审核", "Review")
              : expanded
                ? tr("收起", "Collapse")
                : tr("展开", "Expand")}
          </button>
        </div>
      </div>
      <div className="edited-file-list">
        {visibleFiles.map((file) => (
          <button
            className="edited-file-row"
            key={file.path}
            type="button"
            disabled={!hasSnapshots}
            onClick={() => onReview(file.path)}
            title={
              hasSnapshots
                ? tr(
                    "审核并编辑 {path}",
                    "Review and edit {path}",
                    { path: file.path },
                  )
                : file.path
            }
          >
            <span className="edited-file-name">
              <FileIcon path={file.path} />
              <span title={file.path}>{file.path}</span>
              {file.created && <em>{tr("新增", "New")}</em>}
              {file.deleted && <em className="deleted">{tr("已删除", "Deleted")}</em>}
              {file.reverted && <em className="reverted">{tr("已撤销", "Reverted")}</em>}
            </span>
            {file.reverted ? (
              <span className="legacy-file-status">{tr("检查点已恢复", "Checkpoint restored")}</span>
            ) : file.legacy ? (
              <span className="legacy-file-status">{tr("已创建", "Created")}</span>
            ) : file.binary ? (
              <span className="office-file-status">
                {file.artifact?.label || tr("Office 工件", "Office artifact")}
              </span>
            ) : (
              <span className="edited-file-diff">
                <b className="diff-add">+{file.additions}</b>
                <b className="diff-delete">-{file.deletions}</b>
              </span>
            )}
          </button>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          className="show-more-files"
          type="button"
          onClick={() => setExpanded(true)}
        >
          {tr("再显示 {count} 个文件", "Show {count} more file(s)", { count: hiddenCount })}
          <ChevronDown size={14} />
        </button>
      )}
    </section>
  );
}

function SelfCheckCard({ selfCheck }) {
  const { tr } = useI18n();
  if (!selfCheck?.required || !selfCheck.completed) return null;
  const reviewedCount = selfCheck.reviewedFiles?.length || 0;
  const improvementCount = selfCheck.improvements?.length || 0;
  const remainingRisks = selfCheck.remainingRisks || [];
  const verification = selfCheck.verification;

  return (
    <section className="self-check-card">
      <div className="self-check-heading">
        <span className="self-check-icon">
          <Check size={14} />
        </span>
        <div>
          <strong>{tr("强制自检已完成", "Mandatory self-check completed")}</strong>
          <span>
            {tr("已复核 {count} 个文件", "Reviewed {count} file(s)", { count: reviewedCount })}
            {improvementCount > 0
              ? tr("，自检中完成 {count} 项改进", "; completed {count} improvement(s)", { count: improvementCount })
              : tr("，未发现必须继续修改的问题", "; no blocking issues found")}
          </span>
        </div>
      </div>
      {selfCheck.summary && <p>{selfCheck.summary}</p>}
      {verification?.required && (
        <div
          className={`self-check-verification ${
            verification.passed ? "passed" : "not-passed"
          }`}
        >
          <strong>
            {verification.passed
              ? tr("项目验证已通过", "Project verification passed")
              : verification.attempted
                ? tr("项目验证未通过", "Project verification failed")
                : tr("项目验证未执行", "Project verification was not run")}
          </strong>
          <span>
            {verification.results?.length
              ? verification.results
                  .map(
                    (result) =>
                      `${result.command}${
                        result.exitCode === null
                          ? ""
                          : tr("（退出码 {code}）", " (exit code {code})", { code: result.exitCode })
                      }`,
                  )
                  .join("；")
              : tr("Harness 已发现验证脚本，但没有可用结果。", "Harness found a verification script but no result was available.")}
          </span>
        </div>
      )}
      {remainingRisks.length > 0 && (
        <details>
          <summary>{tr("仍需人工确认 {count} 项", "{count} item(s) still need human review", { count: remainingRisks.length })}</summary>
          <ul>
            {remainingRisks.map((risk, index) => (
              <li key={`${index}-${risk}`}>{risk}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function AssistantMessage({ message, onRetry }) {
  const { tr } = useI18n();
  const failed = message.error || message.status === "failed";
  const interrupted = message.status === "interrupted";

  return (
    <article
      className={`assistant-message ${failed ? "error" : ""} ${interrupted ? "interrupted" : ""}`}
    >
      <div className="assistant-message-heading">
        <strong>
          {failed
            ? tr("运行失败", "Run failed")
            : interrupted
              ? tr("任务已停止", "Task stopped")
              : "AporiaX"}
        </strong>
      </div>
      <div className="assistant-message-content">
        {message.content ? (
          failed ? (
            message.content
          ) : (
            <MarkdownMessage content={message.content} />
          )
        ) : (
          <span className="stream-placeholder">{tr("正在生成回复…", "Generating a response…")}</span>
        )}
      </div>
      {(failed || interrupted) && message.prompt && (
        <button
          className="retry-message-button"
          type="button"
          onClick={() => onRetry(message)}
        >
          <RotateCcw size={13} />
          {message.recoverable
            ? tr("恢复任务", "Resume task")
            : tr("重试本轮", "Retry turn")}
        </button>
      )}
    </article>
  );
}

function getLiveRunProgress(message) {
  const planSteps = message?.plan?.steps || [];
  if (planSteps.length) {
    const completedCount = planSteps.filter(
      (step) => step.status === "completed",
    ).length;
    const blockedCount = planSteps.filter(
      (step) => step.status === "blocked",
    ).length;
    const currentStep =
      planSteps.find((step) => step.status === "in_progress") ||
      planSteps.find((step) => step.status === "pending") ||
      planSteps.at(-1) ||
      null;
    const inProgressCredit = planSteps.some(
      (step) => step.status === "in_progress",
    )
      ? 0.35
      : 0;
    return {
      entries: message?.route || [],
      completedCount,
      currentEntry: currentStep
        ? {
            title: currentStep.title,
            detail: currentStep.detail || "",
            stage: "route",
          }
        : null,
      progress: Math.min(
        message?.status === "running" ? 96 : 100,
        Math.round(
          ((completedCount + inProgressCredit) / planSteps.length) * 100,
        ),
      ),
      totalCount: planSteps.length,
      blockedCount,
      plan: message.plan,
    };
  }
  const entries = message?.route || [];
  const completedCount = entries.filter((entry) =>
    ["completed", "skipped", "recovered"].includes(entry.status),
  ).length;
  const currentEntry =
    [...entries]
      .reverse()
      .find((entry) => ["running", "waiting", "retry"].includes(entry.status)) ||
    entries.at(-1) ||
    null;
  const stageBase = {
    route: 12,
    forge: 42,
    trial: 74,
    deliver: 93,
  };
  const base = stageBase[currentEntry?.stage] || 8;
  const progress = Math.min(96, base + Math.min(12, completedCount * 2));
  return {
    entries,
    completedCount,
    currentEntry,
    progress,
    totalCount: entries.length,
    blockedCount: entries.filter((entry) => entry.status === "failed").length,
    plan: null,
  };
}

function Conversation({
  task,
  isRunning,
  runStatus,
  approval,
  approvalResponding,
  onRespondApproval,
  onRetry,
  onRevert,
  onConfirmChanges,
  onSaveChanges,
  onNotice,
}) {
  const { tr } = useI18n();
  const [reviewRequest, setReviewRequest] = useState(null);
  const [reverting, setReverting] = useState(false);
  const reviewMessage = task.messages.find(
    (message) => message.id === reviewRequest?.messageId,
  );
  const activeRunMessage = [...task.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.status === "running",
    );
  const liveProgress = getLiveRunProgress(activeRunMessage);

  const revertChanges = async (paths) => {
    if (!reviewMessage) return;
    setReverting(true);
    try {
      await onRevert(reviewMessage.id, paths);
    } finally {
      setReverting(false);
    }
  };

  if (!task.messages.length) {
    return (
      <div className="conversation-empty">
        <h2>{tr("从这里，穿过不确定性。", "Trace a path through uncertainty.")}</h2>
        <p>
          {tr(
            "描述你想抵达的结果。AporiaX 会规划路径、留下证据，并为关键修改保留回退锚点。",
            "Describe the outcome you want. AporiaX will plan a route, preserve evidence, and anchor important changes for rollback.",
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {task.messages.map((message) => {
        if (message.role === "user") {
          return (
          <article
            className={`user-message ${message.queued ? "queued" : ""} ${message.steeringStatus ? "steering" : ""}`}
            key={message.id}
          >
            {message.content && (
              <div className="message-bubble">{message.content}</div>
            )}
            <UserAttachments attachments={message.attachments} />
            {message.queued && (
              <span className="queued-message-state">
                <LoaderCircle size={12} />
                {tr("已排队，当前任务完成后继续", "Queued · runs after the current task")}
              </span>
            )}
            {message.steeringStatus && !message.queued && (
              <span className={`steering-message-state ${message.steeringStatus}`}>
                {message.steeringStatus === "pending" && (
                  <LoaderCircle size={12} />
                )}
                {message.steeringStatus === "applied" && <Check size={12} />}
                {message.steeringStatus === "failed" && <AlertTriangle size={12} />}
                {message.steeringStatus === "pending"
                  ? tr(
                      "等待下一安全边界应用",
                      "Waiting for the next safe boundary",
                    )
                  : message.steeringStatus === "applied"
                    ? tr("已应用到当前任务", "Applied to the current task")
                    : tr("即时纠偏失败，已转入队列", "Live steering failed and was queued")}
              </span>
            )}
          </article>
          );
        }

        const files = collectEditedFiles(
          message.steps,
          message.content,
          message.changes,
        );
        return (
          <React.Fragment key={message.id}>
            <AssistantMessage message={message} onRetry={onRetry} />
            {files.length > 0 && (
              <EditedFilesCard
                files={files}
                hasSnapshots={Boolean(message.changes?.length)}
                confirmed={Boolean(message.reviewConfirmedAt)}
                onReview={(path) =>
                  setReviewRequest({
                    messageId: message.id,
                    path,
                    mode: path ? "edit" : "diff",
                  })
                }
              />
            )}
            <SelfCheckCard selfCheck={message.selfCheck} />
          </React.Fragment>
        );
      })}
      <ApprovalCard
        approval={approval}
        responding={approvalResponding}
        onRespond={onRespondApproval}
      />
      {isRunning && (
        <div className="harness-running">
          <div className="harness-running-heading">
            <span className="harness-running-icon">
              <LoaderCircle className="spin" size={15} />
            </span>
            <div>
              <strong>{runStatus?.title || tr("Harness 正在运行", "Harness is running")}</strong>
              <span>
                {tr(
                  "约 {progress}% · 已完成 {count} 个动作",
                  "About {progress}% · {count} action(s) complete",
                  {
                    progress: liveProgress.progress,
                    count: liveProgress.completedCount,
                  },
                )}
              </span>
            </div>
            <b>{liveProgress.progress}%</b>
          </div>
          <div className="harness-progress-track" aria-hidden="true">
            <span style={{ width: `${liveProgress.progress}%` }} />
          </div>
          <div className="harness-current-action">
            <span>{tr("正在做", "Now")}</span>
            <div>
              <strong>
                {liveProgress.currentEntry?.title ||
                  tr("理解任务并规划下一步", "Understanding the task and planning next steps")}
              </strong>
              <p>
                {liveProgress.currentEntry?.path ||
                  liveProgress.currentEntry?.detail ||
                  runStatus?.detail ||
                  tr(
                    "模型正在检查授权工作区并规划下一步。",
                    "The model is inspecting the authorized workspace and planning its next step.",
                  )}
              </p>
            </div>
          </div>
        </div>
      )}
      {reviewMessage?.changes?.length > 0 && (
        <DiffReviewPanel
          changes={reviewMessage.changes}
          confirmed={Boolean(reviewMessage.reviewConfirmedAt)}
          reverting={reverting}
          workspacePath={task.workspacePath}
          initialPath={reviewRequest?.path || ""}
          initialMode={reviewRequest?.mode || "diff"}
          onClose={() => setReviewRequest(null)}
          onConfirm={() => onConfirmChanges(reviewMessage.id)}
          onSave={(result) =>
            onSaveChanges(reviewMessage.id, result)
          }
          onNotice={onNotice}
          onRevert={revertChanges}
        />
      )}
    </div>
  );
}

function RouteView({
  task,
  isRunning,
  runStatus,
  approval,
  approvalResponding,
  onRespondApproval,
  onRevert,
  onSaveChanges,
  onNotice,
}) {
  const { tr, language } = useI18n();
  const runs = collectTaskRouteRuns(task);
  const latestRunId = runs.at(-1)?.id || null;
  const [selectedRunId, setSelectedRunId] = useState(latestRunId);
  const [review, setReview] = useState(null);
  const [reverting, setReverting] = useState(false);
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) || runs.at(-1);
  const entries = selectedRun?.entries || [];
  const planSteps = selectedRun?.plan?.steps || [];
  const completedCount = planSteps.length
    ? planSteps.filter((step) => step.status === "completed").length
    : entries.filter((entry) =>
        ["completed", "skipped", "retry", "recovered"].includes(
          entry.status,
        ),
      ).length;
  const totalCount = planSteps.length || entries.length;
  const selectedRunIndex = Math.max(
    0,
    runs.findIndex((run) => run.id === selectedRun?.id),
  );
  const reviewRun = runs.find((run) => run.id === review?.runId);
  const reviewChanges = (reviewRun?.changes || []).filter(
    (change) => !review?.paths?.length || review.paths.includes(change.path),
  );

  useEffect(() => {
    setSelectedRunId(latestRunId);
    setReview(null);
  }, [task.id]);

  useEffect(() => {
    if (!isRunning || !latestRunId) return;
    setSelectedRunId(latestRunId);
    setReview(null);
  }, [isRunning, latestRunId]);

  const revertChanges = async (paths) => {
    if (!reviewRun) return;
    setReverting(true);
    try {
      await onRevert(reviewRun.messageId, paths);
    } finally {
      setReverting(false);
    }
  };

  if (!runs.length && !isRunning) {
    return (
      <div className="route-empty">
        <span>Route</span>
        <h2>{tr("行动路径尚未展开。", "No route has unfolded yet.")}</h2>
        <p>{tr("任务开始执行后，真实的观察、修改与验证会依次出现在这里。", "Once execution begins, observations, changes, and verification will appear here in order.")}</p>
      </div>
    );
  }

  return (
    <>
      <div className="route-view">
        <header className="route-overview">
          <div>
            <span className="route-kicker">
              {tr("Route · 第 {count} 次任务", "Route · Task run {count}", { count: selectedRunIndex + 1 })}
            </span>
            <h2>
              {selectedRun?.summary ||
                summarizeRoutePrompt(selectedRun?.prompt || task.title)}
            </h2>
          </div>
          <div className="route-overview-actions">
            {runs.length > 1 && (
              <label className="route-run-picker">
                <span>{tr("任务轮次", "Task run")}</span>
                <select
                  value={selectedRun?.id || ""}
                  disabled={isRunning}
                  onChange={(event) => {
                    setSelectedRunId(event.target.value);
                    setReview(null);
                  }}
                >
                  {runs.map((run, index) => (
                    <option value={run.id} key={run.id}>
                      {String(index + 1).padStart(2, "0")} ·{" "}
                      {run.summary || summarizeRoutePrompt(run.prompt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div
              className={`route-state ${
                selectedRun?.status === "running" ? "running" : ""
              }`}
            >
              <span />
              {selectedRun?.status === "running"
                  ? tr("执行中", "Running")
                  : tr("{done}/{total} 步完成", "{done}/{total} steps complete", {
                    done: completedCount,
                    total: totalCount,
                  })}
            </div>
          </div>
        </header>

        {planSteps.length > 0 && (
          <section className="route-plan" aria-label={tr("执行计划", "Execution plan")}>
            <header>
              <div>
                <span>{tr("执行计划", "Execution plan")}</span>
                <strong>
                  {tr(
                    "{done}/{total} 个目标已完成",
                    "{done}/{total} objectives complete",
                    { done: completedCount, total: planSteps.length },
                  )}
                </strong>
              </div>
              <em>{tr("修订 {revision}", "Revision {revision}", { revision: selectedRun.plan.revision || 1 })}</em>
            </header>
            <ol>
              {planSteps.map((step, index) => {
                const evidence = entries.filter(
                  (entry) => entry.planStepId === step.id,
                );
                return (
                  <li className={step.status} key={step.id}>
                    <span className="route-plan-index">
                      {step.status === "completed" ? (
                        <Check size={14} />
                      ) : step.status === "in_progress" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : step.status === "blocked" ? (
                        <AlertTriangle size={14} />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <div>
                      <strong>{step.title}</strong>
                      {step.detail && <p>{step.detail}</p>}
                      {evidence.length > 0 && (
                        <small>
                          {tr(
                            "{count} 条行动证据",
                            "{count} action record(s)",
                            { count: evidence.length },
                          )}
                        </small>
                      )}
                    </div>
                    <em>
                      {step.status === "completed"
                        ? tr("完成", "Done")
                        : step.status === "in_progress"
                          ? tr("进行中", "In progress")
                          : step.status === "blocked"
                            ? tr("受阻", "Blocked")
                            : tr("待处理", "Pending")}
                    </em>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <div className="route-evidence-heading">
          <span>{tr("行动证据", "Action evidence")}</span>
          <em>{tr("{count} 条记录", "{count} records", { count: entries.length })}</em>
        </div>
        <div className="route-step-list">
          {entries.map((entry, index) => {
            const entryTitle = entry.tool
              ? getRouteToolMeta(entry.tool, entry.phase, language).title
              : entry.kind === "self-check-start"
                ? tr("进入强制自检", "Begin mandatory self-check")
                : entry.kind === "self-check-complete"
                  ? tr("强制自检已完成", "Mandatory self-check completed")
                  : entry.stage === "deliver"
                    ? tr("整理最终产物", "Prepare final deliverables")
                    : entry.title;
            const duration = formatRouteDuration(entry);
            const normalizedPath = entry.path
              ?.replaceAll("\\", "/")
              .toLowerCase();
            const relatedChanges = (selectedRun?.changes || []).filter(
              (change) =>
                normalizedPath &&
                change.path.replaceAll("\\", "/").toLowerCase() ===
                  normalizedPath,
            );
            const artifact = entry.artifact || relatedChanges[0]?.artifact;
            const detail =
              entry.path ||
              entry.command ||
              entry.detail ||
              (entry.exitCode === 0
                ? tr("命令执行成功", "Command completed successfully")
                : tr("Harness 行动记录", "Harness action record"));
            const statusText =
              entry.status === "running"
                ? tr("正在执行", "Running")
                : entry.status === "waiting"
                  ? tr("等待批准", "Awaiting approval")
                  : entry.status === "skipped"
                    ? tr("不适用", "Not applicable")
                    : entry.status === "retry"
                      ? entry.tool === "complete_self_check"
                        ? tr("已转入补检", "Additional checks queued")
                        : tr("等待重试", "Awaiting retry")
                      : entry.status === "recovered"
                        ? tr("已重试成功", "Recovered")
                        : entry.status === "failed"
                          ? tr("未完成", "Incomplete")
                          : duration || tr("完成", "Complete");
            return (
              <details
                className={`route-step ${entry.status || "completed"}`}
                key={entry.id}
                open={
                  entry.status === "running" || index === entries.length - 1
                }
              >
                <summary>
                  <span className="route-step-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="route-step-copy">
                    <strong>{entryTitle}</strong>
                    <span title={detail}>{detail}</span>
                  </span>
                  <em>{statusText}</em>
                  <ChevronDown size={15} />
                </summary>
                <div className="route-step-detail">
                  {entry.tool && (
                    <div>
                      <span>{tr("工具", "Tool")}</span>
                      <code>{entry.tool}</code>
                    </div>
                  )}
                  {entry.path && (
                    <div>
                      <span>{tr("文件", "File")}</span>
                      <code>{entry.path}</code>
                    </div>
                  )}
                  {entry.command && (
                    <div>
                      <span>{tr("命令", "Command")}</span>
                      <code>{entry.command}</code>
                    </div>
                  )}
                  {(entry.additions > 0 || entry.deletions > 0) && (
                    <div>
                      <span>{tr("修改", "Changes")}</span>
                      <p className="route-change-count">
                        <b>+{entry.additions || 0}</b>
                        <i>-{entry.deletions || 0}</i>
                      </p>
                    </div>
                  )}
                  {artifact && (
                    <div>
                      <span>{tr("产物", "Artifact")}</span>
                      <p>
                        {artifact.label || getDeliverableType({ path: entry.path || "" })}
                      </p>
                    </div>
                  )}
                  {entry.detail && (
                    <div>
                      <span>{tr("结果", "Result")}</span>
                      <p>{entry.detail}</p>
                    </div>
                  )}
                  {relatedChanges.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setReview({
                          runId: selectedRun.id,
                          paths: relatedChanges.map((change) => change.path),
                          path: relatedChanges[0]?.path || "",
                        })
                      }
                    >
                      {tr("查看具体修改", "View changes")}
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </details>
            );
          })}
        </div>

        {isRunning &&
          selectedRun?.status === "running" &&
          runStatus && (
            <div className="route-live-status">
              <LoaderCircle className="spin" size={15} />
              <div>
                <strong>{runStatus.title}</strong>
                <span>{runStatus.detail}</span>
              </div>
            </div>
          )}

        <ApprovalCard
          approval={approval}
          responding={approvalResponding}
          onRespond={onRespondApproval}
        />
      </div>
      {reviewChanges.length > 0 && (
        <DiffReviewPanel
          changes={reviewChanges}
          reverting={reverting}
          workspacePath={task.workspacePath}
          initialPath={review?.path || ""}
          onClose={() => setReview(null)}
          onSave={(result) =>
            onSaveChanges(reviewRun.messageId, result)
          }
          onNotice={onNotice}
          onRevert={revertChanges}
        />
      )}
    </>
  );
}

function SettingsPanel({
  task,
  onClose,
  onUpdateTask,
  providers,
  onManageProviders,
  sandboxStatus,
  sandboxPreparing,
  onPrepareSandbox,
  onSelectWorkspace,
  style,
}) {
  const { tr } = useI18n();
  const provider =
    providers.find((candidate) => candidate.id === task.providerId) ||
    providers[0];
  return (
    <aside className="settings-panel" style={style}>
      <div className="settings-panel-header">
        <div>
          <span className="eyebrow">{tr("当前任务", "Current task")}</span>
          <h2>{tr("任务设置", "Task settings")}</h2>
        </div>
        <IconButton label={tr("关闭设置面板", "Close settings")} onClick={onClose}>
          <PanelRightClose size={18} />
        </IconButton>
      </div>

      <section className="settings-section">
        <div className="settings-label">{tr("模型服务", "Model service")}</div>
        <div className="api-status-row">
          <div className="api-status-copy">
            <span className={`api-status-dot ${provider ? "ready" : ""}`} />
            <div>
              <strong>
                {provider
                  ? tr("{name} · {count} 个模型", "{name} · {count} model(s)", {
                      name: provider.name,
                      count: provider.models?.length || 0,
                    })
                  : tr("需要添加模型 API", "Add a model API")}
              </strong>
              <span>
                {provider?.baseUrl ||
                  tr("支持多个 OpenAI-compatible Provider", "Supports multiple OpenAI-compatible providers")}
              </span>
            </div>
          </div>
          <button className="settings-link" onClick={onManageProviders}>
            {provider ? tr("管理", "Manage") : tr("添加", "Add")}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-label">{tr("命令沙箱", "Command sandbox")}</div>
        <div className="sandbox-status-card">
          <span
            className={`sandbox-status-icon ${
              sandboxStatus?.available || sandboxStatus?.localAvailable
                ? "ready"
                : "fallback"
            }`}
          >
            {sandboxStatus?.available || sandboxStatus?.localAvailable ? (
              <LockKeyhole size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
          </span>
          <div>
            <strong>
              {!sandboxStatus
                ? tr("正在检测沙箱", "Checking sandbox")
                : sandboxStatus.available
                  ? tr("Docker 强隔离已就绪", "Docker strong isolation ready")
                  : sandboxStatus.localAvailable
                    ? tr("本地沙箱已就绪", "Local sandbox ready")
                    : tr("沙箱暂不可用", "Sandbox unavailable")}
            </strong>
            <span>
              {sandboxStatus?.detail ||
                tr("正在检测 Docker 与 AporiaX 沙箱镜像", "Checking Docker and the AporiaX sandbox image")}
            </span>
          </div>
        </div>
        {!sandboxStatus?.available && (
          <button
            className="workspace-settings-button"
            type="button"
            disabled={sandboxPreparing}
            onClick={onPrepareSandbox}
          >
            {sandboxPreparing && (
              <LoaderCircle className="spin" size={14} />
            )}
            {sandboxPreparing
              ? tr("正在准备 Docker 强隔离", "Preparing Docker isolation")
              : tr("启用 Docker 加强隔离（可选）", "Enable stronger Docker isolation (optional)")}
          </button>
        )}
        {sandboxStatus?.available && (
          <div className="sandbox-constraints">
            <span>{tr("断网", "Offline")}</span>
            <span>{tr("只读系统", "Read-only system")}</span>
            <span>{sandboxStatus.memory || "1536m"}</span>
            <span>{tr("{count} 进程", "{count} processes", { count: sandboxStatus.pidsLimit || 256 })}</span>
          </div>
        )}
        {sandboxStatus && !sandboxStatus.available && (
          <div className="sandbox-constraints fallback">
            <span>{tr("临时工作区", "Temporary workspace")}</span>
            <span>{tr("自动执行", "Automatic execution")}</span>
            <span>{tr("使用本机网络", "Host network")}</span>
            <span>{tr("Docker 可选", "Docker optional")}</span>
          </div>
        )}
        <div className="sandbox-auto-approval">
          <div>
            <strong>{tr("命令自动执行", "Automatic command execution")}</strong>
            <span>
              {tr(
                "本地临时工作区与 Docker 沙箱内的命令不再逐条确认；关闭后恢复手动审批。",
                "Commands in the local temporary workspace and Docker sandbox run without repeated prompts. Turn this off to restore manual approval.",
              )}
            </span>
          </div>
          <Switch
            checked={task.approvalMode !== "manual"}
            label={tr("命令自动执行", "Automatic command execution")}
            onChange={(enabled) =>
              onUpdateTask({
                approvalMode: enabled ? "sandbox-auto" : "manual",
              })
            }
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-label">{tr("工作目录", "Workspace")}</div>
        <div className="workspace-summary">
          {task.workspacePath ? (
            <FolderOpen size={17} />
          ) : (
            <Folder size={17} />
          )}
          <div>
            <strong>{task.workspaceName}</strong>
            <span title={task.workspacePath || ""}>
              {task.workspacePath || tr("当前任务只能进行纯对话", "This task is limited to conversation")}
            </span>
          </div>
        </div>
        <button
          className="workspace-settings-button"
          onClick={onSelectWorkspace}
        >
          {task.workspacePath
            ? tr("更改工作目录", "Change workspace")
            : tr("绑定工作目录", "Bind workspace")}
        </button>
      </section>

      <section className="settings-section">
        <div className="settings-label">{tr("界面语言", "Interface language")}</div>
        <LanguageSwitch />
        <p className="settings-language-note">
          {tr(
            "界面和新回复会使用所选语言；历史消息与文件内容保持原样。",
            "The interface and new replies use this language; existing messages and files remain unchanged.",
          )}
        </p>
      </section>
    </aside>
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
  onConfirmChanges,
  onSaveChanges,
  runStatus,
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
          ].map((view) => (
            <button
              className={activeView === view.id ? "active" : ""}
              type="button"
              key={view.id}
              onClick={() => {
                if (view.id === "workspace" && !task.workspacePath) {
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
              runStatus={runStatus}
              approval={approval}
              approvalResponding={approvalResponding}
              onRespondApproval={onRespondApproval}
              onRetry={onRetry}
              onRevert={onRevert}
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
              runStatus={runStatus}
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
              <span>A</span>
              <i>X</i>
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
            ) : (
              <section className="application-about">
                <span className="application-about-mark">
                  <span>A</span>
                  <i>X</i>
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
  const [tasks, setTasks] = useState(readSavedTasks);
  const [activeTaskId, setActiveTaskId] = useState(
    () => readSavedTasks()[0]?.id || null,
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
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
  const [runningTaskId, setRunningTaskId] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const [runPaused, setRunPaused] = useState(false);
  const [runStatus, setRunStatus] = useState(null);
  const [approval, setApproval] = useState(null);
  const [approvalResponding, setApprovalResponding] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [theme, setTheme] = useState(readSavedTheme);
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const runsRef = useRef(new Map());
  const tasksRef = useRef(tasks);

  const activeTask = tasks.find((task) => task.id === activeTaskId) || null;

  const openApplicationSettings = (section = "general") => {
    setApplicationSettingsSection(section);
    setApplicationSettingsOpen(true);
  };

  const requestNewTask = () => {
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
    cacheTasksLocally(tasks);
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
        let hydratedTasks =
          storedTasks === null ||
          (storedTasks.length === 0 && tasksRef.current.length > 0)
            ? tasksRef.current
            : storedTasks;
        if (
          storedTasks === null ||
          (storedTasks.length === 0 && tasksRef.current.length > 0)
        ) {
          await window.desktop.tasks.save(tasksRef.current);
        }
        const recoverableRuns =
          (await window.desktop.harness?.recoverableRuns?.()) || [];
        hydratedTasks = mergeRecoverableRuns(
          hydratedTasks || [],
          recoverableRuns,
          tr,
        );
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
          await Promise.allSettled(
            recoverableRuns.map((record) =>
              window.desktop.harness.acknowledgeRecovery?.(record.runId),
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

  useEffect(() => {
    if (!window.desktop?.harness?.onEvent) return undefined;
    const toolLabels = {
      list_directory: tr("正在浏览工作区", "Browsing workspace"),
      read_file: tr("正在读取文件", "Reading file"),
      search_text: tr("正在搜索代码", "Searching code"),
      git_status: tr("正在检查 Git 状态", "Inspecting Git status"),
      git_diff: tr("正在读取代码差异", "Reading code diff"),
      write_file: tr("正在修改文件", "Writing file"),
      apply_patch: tr("正在精确修改代码", "Applying a precise code patch"),
      create_word_document: tr("正在生成 Word 文档", "Creating Word document"),
      create_presentation: tr("正在生成 PowerPoint", "Creating PowerPoint presentation"),
      create_spreadsheet: tr("正在生成 Excel 工作簿", "Creating Excel workbook"),
      inspect_office_file: tr("正在检查 Office 工件", "Inspecting Office artifact"),
      run_command: tr("正在准备验证命令", "Preparing verification command"),
      update_plan: tr("正在更新执行计划", "Updating the execution plan"),
      complete_self_check: tr("正在提交自检报告", "Submitting self-check report"),
    };
    return window.desktop.harness.onEvent((event) => {
      const run = runsRef.current.get(event.runId);
      if (!run) return;

      if (event.type === "control.paused") {
        setRunPaused(true);
        setRunStatus({
          title: tr("任务已暂停", "Task paused"),
          detail: tr(
            "已停在安全边界；可以补充要求、检查 Route，或继续运行",
            "Stopped at a safe boundary. Add guidance, inspect Route, or resume.",
          ),
        });
        return;
      }

      if (event.type === "control.resumed") {
        setRunPaused(false);
        setRunStatus({
          title: tr("正在继续任务", "Resuming task"),
          detail: tr(
            "将从已保留的上下文与工作区状态继续",
            "Continuing with the preserved context and workspace state",
          ),
        });
        return;
      }

      if (event.type === "steering.queued") {
        setRunStatus({
          title: tr("已收到新的执行要求", "New guidance received"),
          detail: tr(
            "将在下一安全边界合并到当前任务",
            "It will be merged into the current task at the next safe boundary",
          ),
        });
        return;
      }

      if (event.type === "steering.applied") {
        const messageIds = new Set(event.messageIds || []);
        setTasks((current) =>
          current.map((task) =>
            task.id === run.taskId
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    messageIds.has(message.id)
                      ? {
                          ...message,
                          queued: false,
                          steeringStatus: "applied",
                          appliedAt: new Date().toISOString(),
                        }
                      : message,
                  ),
                }
              : task,
          ),
        );
        setRunStatus({
          title: tr("新要求已接入当前任务", "Guidance applied to the current task"),
          detail: tr(
            "AporiaX 正在依据新要求调整后续步骤",
            "AporiaX is adapting the remaining steps to the new guidance",
          ),
        });
        return;
      }

      if (event.type === "plan.updated") {
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            plan: event.plan,
          })),
        );
        const activeStep = event.plan?.steps?.find(
          (step) => step.status === "in_progress",
        );
        setRunStatus({
          title: tr("执行计划已更新", "Execution plan updated"),
          detail:
            activeStep?.title ||
            tr(
              "Route 已同步为模型当前的真实计划",
              "Route now reflects the model's current plan",
            ),
        });
        return;
      }

      if (event.type === "turn.started") {
        setRunPaused(false);
        if (event.sandbox) setSandboxStatus(event.sandbox);
        run.sandbox = event.sandbox || null;
        run.approvalMode = event.approvalMode || "manual";
        return;
      }

      if (event.type === "response.reset") {
        setTasks((current) =>
          current.map((task) =>
            task.id === run.taskId
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    message.id === run.assistantId
                      ? { ...message, content: "" }
                      : message,
                  ),
                }
              : task,
          ),
        );
        setRunStatus({
          title:
            event.phase === "self-check"
              ? tr("AporiaX 正在强制自检", "AporiaX is running its mandatory self-check")
              : tr("AporiaX 正在生成", "AporiaX is responding"),
          detail:
            event.phase === "self-check"
              ? tr("正在重新读取本轮修改的代码并检查可改进项", "Re-reading this turn's changes and looking for improvements")
              : event.round > 1
                ? tr("正在处理第 {round} 轮工具结果", "Processing tool results from round {round}", { round: event.round })
                : tr("正在理解任务并规划操作", "Understanding the task and planning actions"),
        });
        return;
      }

      if (event.type === "response.delta") {
        setTasks((current) =>
          current.map((task) =>
            task.id === run.taskId
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    message.id === run.assistantId
                      ? {
                          ...message,
                          content: `${message.content || ""}${event.delta || ""}`,
                        }
                      : message,
                  ),
                }
              : task,
          ),
        );
        return;
      }

      if (event.type === "response.retry") {
        setTasks((current) =>
          current.map((task) =>
            task.id === run.taskId
              ? {
                  ...task,
                  messages: task.messages.map((message) =>
                    message.id === run.assistantId
                      ? { ...message, content: "" }
                      : message,
                  ),
                }
              : task,
          ),
        );
        setRunStatus({
          title: tr(
            "{provider} 正在自动重试 {attempt}/{max}",
            "{provider} is retrying automatically {attempt}/{max}",
            {
              provider: event.provider || tr("模型服务", "Model service"),
              attempt: event.attempt,
              max: event.maxAttempts,
            },
          ),
          detail: tr("请求暂时无响应或服务繁忙，已保留本轮任务状态", "The request timed out or the service is busy. This turn's state has been preserved."),
        });
        return;
      }

      if (event.type === "context.compacted") {
        setRunStatus({
          title: tr("正在压缩长任务上下文", "Compacting long task context"),
          detail: tr("已压缩 {count} 条旧工具输出，保留最近操作", "Compacted {count} older tool outputs while retaining recent actions", { count: event.compactedMessages || 0 }),
        });
        return;
      }

      if (event.type === "tool.started") {
        const meta = getRouteToolMeta(event.tool, event.phase, language);
        const now = new Date().toISOString();
        run.routeCounter = (run.routeCounter || 0) + 1;
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...(message.route || []).map((entry) =>
                entry.tool === "complete_self_check" &&
                entry.status === "running"
                  ? entry
                  : closeRunningRouteEntries([entry], now)[0],
              ),
              {
                id: `${event.runId}-tool-${run.routeCounter}`,
                stage: meta.stage,
                title: meta.title,
                tool: event.tool,
                phase: event.phase,
                path: event.path || "",
                command: event.command || "",
                detail: event.detail || "",
                planStepId: event.planStepId || null,
                status: "running",
                startedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: toolLabels[event.tool] || tr("Harness 正在运行", "Harness is running"),
          detail:
            event.path ||
            event.command ||
            event.detail ||
            (event.tool === "run_command"
              ? run.approvalMode === "sandbox-auto"
                ? tr(
                    run.sandbox?.available
                      ? "命令将在 Docker 强隔离沙箱内自动执行"
                      : "命令将在本地临时工作区内自动执行",
                    run.sandbox?.available
                      ? "The command will run automatically in the strongly isolated Docker sandbox"
                      : "The command will run automatically in a temporary local workspace",
                  )
                : tr(
                    "命令正在等待手动批准",
                    "The command is waiting for manual approval",
                  )
              : event.phase === "self-check"
                ? tr("强制复核本轮修改，发现问题会继续修复", "Reviewing this turn's changes and continuing to fix any issues")
                : tr("操作范围限制在当前工作区内", "Actions are limited to the current workspace")),
        });
        return;
      }

      if (event.type === "tool.completed") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => {
            const route = [...(message.route || [])];
            const routeIndex = route.findLastIndex(
              (entry) =>
                entry.tool === event.tool &&
                ["running", "waiting"].includes(entry.status),
            );
            if (routeIndex >= 0) {
              route[routeIndex] = {
                ...route[routeIndex],
                status: event.skipped
                  ? "skipped"
                  : event.retry
                    ? "retry"
                    : event.success
                      ? "completed"
                      : "failed",
                detail: event.detail || route[routeIndex].detail,
                finishedAt: now,
              };
            }
            if (event.success && !event.skipped && routeIndex >= 0) {
              for (let index = 0; index < routeIndex; index += 1) {
                if (
                  route[index].tool === event.tool &&
                  ["failed", "retry"].includes(route[index].status)
                ) {
                  route[index] = {
                    ...route[index],
                    status: "recovered",
                    detail:
                      route[index].detail ||
                      tr("后续重试已成功", "A later retry succeeded"),
                  };
                }
              }
            }
            return { ...message, route };
          }),
        );
        setRunStatus({
          title: event.skipped
            ? tr("检查不适用于当前工作区", "Check is not applicable to this workspace")
            : event.retry
              ? event.tool === "complete_self_check"
                ? tr("自检条件尚未满足", "Self-check conditions are not yet satisfied")
                : tr("工具参数将自动重试", "Tool arguments will be retried automatically")
              : event.success
                ? tr("操作已完成", "Action completed")
                : tr("操作未完成", "Action incomplete"),
          detail:
            event.detail ||
            (event.success
              ? tr("正在整理结果并决定下一步", "Organizing results and deciding the next step")
              : tr("Agent 正在根据错误调整方案", "The agent is adjusting its plan based on the error")),
        });
        return;
      }

      if (event.type === "file.changed") {
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => {
            const route = [...(message.route || [])];
            const routeIndex = route.findLastIndex(
              (entry) =>
                entry.stage === "forge" &&
                ["running", "waiting"].includes(entry.status),
            );
            if (routeIndex >= 0) {
              route[routeIndex] = {
                ...route[routeIndex],
                path: event.path,
                additions: event.additions || 0,
                deletions: event.deletions || 0,
                artifact: event.artifact || null,
              };
            }
            return { ...message, route };
          }),
        );
        return;
      }

      if (event.type === "self_check.started") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...closeRunningRouteEntries(message.route, now),
              {
                id: `${event.runId}-self-check-start`,
                kind: "self-check-start",
                stage: "trial",
                title: tr("进入强制自检", "Begin mandatory self-check"),
                detail: tr("复核 {count} 个修改文件", "Review {count} changed file(s)", { count: event.paths?.length || 0 }),
                status: "completed",
                startedAt: now,
                finishedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: tr("进入强制自检", "Begin mandatory self-check"),
          detail: event.verificationCandidates?.length
            ? tr("复核 {count} 个文件，并尝试项目构建或测试", "Review {count} file(s), then attempt the project build or tests", { count: event.paths?.length || 0 })
            : tr("必须重新读取 {count} 个修改文件后才能完成任务", "All {count} changed file(s) must be re-read before the task can finish", { count: event.paths?.length || 0 }),
        });
        return;
      }

      if (event.type === "self_check.completed") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...closeRunningRouteEntries(message.route, now),
              {
                id: `${event.runId}-self-check-complete`,
                kind: "self-check-complete",
                stage: "trial",
                title: tr("强制自检已完成", "Mandatory self-check completed"),
                detail: event.report?.verification?.passed
                  ? tr("项目验证已通过", "Project verification passed")
                  : tr("已复核 {count} 个文件", "Reviewed {count} file(s)", { count: event.report?.reviewedFiles?.length || 0 }),
                status: "completed",
                startedAt: now,
                finishedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: tr("强制自检已通过", "Mandatory self-check passed"),
          detail: tr("已复核 {count} 个修改文件，正在整理最终答复", "Reviewed {count} changed file(s); preparing the final response", { count: event.report?.reviewedFiles?.length || 0 }),
        });
        return;
      }

      if (event.type === "turn.completed") {
        const now = new Date().toISOString();
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => ({
            ...message,
            route: [
              ...closeRunningRouteEntries(message.route, now),
              ...((message.route || []).some(
                (entry) => entry.stage === "deliver",
              )
                ? []
                : [
                    {
                      id: `${event.runId}-deliver`,
                      stage: "deliver",
                      title: tr("整理最终产物", "Prepare final deliverables"),
                      status: "completed",
                      startedAt: now,
                      finishedAt: now,
                    },
                  ]),
            ],
          })),
        );
        return;
      }

      if (event.type === "approval.required") {
        setTasks((current) =>
          updateRunAssistant(current, run, (message) => {
            const route = [...(message.route || [])];
            const routeIndex = route.findLastIndex(
              (entry) => entry.status === "running",
            );
            if (routeIndex >= 0) {
              route[routeIndex] = {
                ...route[routeIndex],
                status: "waiting",
              };
            }
            return { ...message, route };
          }),
        );
        setApproval({
          ...event.approval,
          runId: event.runId,
          taskId: run.taskId,
        });
        setRunStatus({
          title: tr("等待命令审批", "Awaiting command approval"),
          detail: event.approval?.sandbox?.available
            ? tr(
                "确认后 Harness 将在隔离的 Docker 容器中执行该命令",
                "After approval, Harness will run this command in the isolated Docker container",
              )
            : tr(
                "确认后 Harness 将在本地临时工作区中执行该命令",
                "After approval, Harness will run this command in a temporary local workspace",
              ),
        });
      }
    });
  }, [language, tr]);

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
  }, [providers, providersReady, tr]);

  const updateActiveTask = (patch) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === activeTaskId ? { ...task, ...patch } : task,
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
    };
    setTasks((current) => [task, ...current]);
    setActiveTaskId(task.id);
    setNewTaskOpen(false);
    setSettingsOpen(false);
    setNotice(tr("任务已创建", "Task created"));
  };

  const deleteTask = (taskId) => {
    if (runningTaskId === taskId) {
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
    if (!window.desktop?.harness) {
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

    if (runningTaskId && !request.force) {
      const createdAt = new Date().toISOString();
      if (
        targetTask.id === runningTaskId &&
        activeRunId &&
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
            runId: activeRunId,
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
    const queuedSource = request.userMessageId
      ? targetTask.messages.find(
          (message) =>
            message.id === request.userMessageId && message.queued,
        )
      : null;
    const userMessage = queuedSource
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
      createdAt: new Date().toISOString(),
    };
    setTasks((current) =>
      current.map((task) =>
        task.id === targetTask.id
          ? {
              ...task,
              messages: queuedSource
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
    setRunningTaskId(targetTask.id);
    setActiveRunId(runId);
    setRunPaused(false);
    setApproval(null);
    setRunStatus({
      title: tr("正在启动 Harness", "Starting Harness"),
      detail: tr("正在加载项目指令与任务上下文", "Loading project instructions and task context"),
    });

    void window.desktop.harness
      .run({
        runId,
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
              !message.queued && message.id !== userMessage.id,
          ),
          userMessage,
        ],
      })
      .then((result) => {
        setTasks((current) =>
          current.map((task) =>
            task.id === targetTask.id
              ? {
                  ...task,
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
                          plan: result.plan || message.plan || null,
                          contextCheckpoints:
                            result.contextCheckpoints ||
                            message.contextCheckpoints ||
                            [],
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
        setRunningTaskId((current) =>
          current === targetTask.id ? null : current,
        );
        setActiveRunId((current) => (current === runId ? null : current));
        setRunPaused(false);
        setApproval((current) =>
          current?.runId === runId ? null : current,
        );
        const nextQueued = tasksRef.current
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
    setApproval(null);
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

  const respondToApproval = async (approved) => {
    if (!approval || !window.desktop?.harness?.respondToApproval) return;
    const currentApproval = approval;
    setApprovalResponding(true);
    try {
      const accepted = await window.desktop.harness.respondToApproval({
        runId: currentApproval.runId,
        approvalId: currentApproval.id,
        approved,
      });
      if (!accepted) {
        setNotice(tr("审批请求已经失效", "The approval request has expired"));
        return;
      }
      setApproval((current) =>
        current?.id === currentApproval.id ? null : current,
      );
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

  const retryMessage = (assistantMessage) => {
    const task = tasksRef.current.find((candidate) =>
      candidate.messages.some(
        (message) => message.id === assistantMessage.id,
      ),
    );
    const sourceMessage = task?.messages.find(
      (message) => message.id === assistantMessage.sourceUserId,
    );
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
        assistantMessage.prompt || sourceMessage?.content || "",
        retryAttachments.filter(
          (attachment) => !isImageAttachment(attachment),
        ),
      );
    }
    return sendMessage(
      assistantMessage.prompt || sourceMessage?.content || "",
      retryAttachments,
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

  const restoreTaskToAnchor = async (taskId, anchorMessageId) => {
    if (!window.desktop?.workspace?.restoreAnchor) {
      setNotice(
        tr(
          "桌面端跨轮恢复能力不可用",
          "Cross-turn restore is unavailable in this desktop build",
        ),
      );
      return { success: false, reason: "bridge-unavailable" };
    }
    if (runningTaskId === taskId) {
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

    const targets = anchorMessages
      .slice(selectedIndex)
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
            runningTaskId={runningTaskId}
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
              onConfirmChanges={confirmMessageChanges}
              onSaveChanges={saveReviewedMessageChange}
              runStatus={runStatus}
              approval={
                approval?.taskId === activeTask.id ? approval : null
              }
              approvalResponding={approvalResponding}
              onRespondApproval={respondToApproval}
              onUpdateTask={updateActiveTask}
              isRunning={runningTaskId === activeTask.id}
              isPaused={
                runningTaskId === activeTask.id && runPaused
              }
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
