import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
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
  ImagePlus,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  SquarePen,
  Moon,
  Sun,
  Trash2,
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
  updateRunAssistant,
} from "./p0-model";
import WelcomeParticleOcean from "./WelcomeParticleOcean";
import "./styles.css";

const STORAGE_KEY = "aporiax.tasks.v1";
const SIDEBAR_COLLAPSED_KEY = "aporiax.sidebar-collapsed.v1";
const SETTINGS_PANEL_WIDTH_KEY = "aporiax.settings-panel-width.v1";
const FILES_PANEL_WIDTH_KEY = "aporiax.files-panel-width.v1";
const THEME_STORAGE_KEY = "aporiax.theme.v1";
const DEFAULT_SETTINGS_PANEL_WIDTH = 320;
const DEFAULT_FILES_PANEL_WIDTH = 520;

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

const MODELS = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    shortName: "V4 Pro",
    description: "复杂规划、编码与长工具链 · 仅文本",
    supportsImages: false,
    icon: Brain,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    shortName: "V4 Flash",
    description: "快速问答、摘要与日常任务 · 仅文本",
    supportsImages: false,
    icon: Zap,
  },
];

const DEFAULT_CONFIG = {
  modelId: "deepseek-v4-pro",
  thinking: true,
  effort: "high",
  permission: "workspace-write",
};

function readSavedTasks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function getFolderName(folderPath) {
  if (!folderPath) return "";
  const parts = folderPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || folderPath;
}

function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId) || MODELS[0];
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

function AppTitlebar() {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <div className="brand-mark">
          <span>A</span>
          <i>X</i>
        </div>
        <span>AporiaX</span>
      </div>
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
          aria-label="进入 AporiaX"
          onClick={onContinue}
        >
          进入
          <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}

function Sidebar({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  searchOpen,
  onToggleSearch,
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
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

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-heading">
          <span>任务</span>
          <IconButton label="搜索任务" onClick={onToggleSearch}>
            <Search size={16} />
          </IconButton>
        </div>

        <button className="new-task-button" onClick={onNewTask}>
          <SquarePen size={17} />
          <span>新建任务</span>
          <span className="new-task-shortcut">Ctrl N</span>
        </button>

        {searchOpen && (
          <div className="sidebar-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务"
              aria-label="搜索任务"
            />
            {query && (
              <button aria-label="清空搜索" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="task-list">
        <div className="section-label">最近任务</div>
        {filteredTasks.length ? (
          filteredTasks.map((task) => (
            <button
              key={task.id}
              className={`task-item ${task.id === activeTaskId ? "active" : ""}`}
              onClick={() => onSelectTask(task.id)}
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
            {tasks.length ? "没有匹配的任务" : "暂无任务"}
          </div>
        )}
      </div>
    </aside>
  );
}

function ModelChoice({ model, selected, onSelect, compact = false }) {
  const ModelIcon = model.icon;

  return (
    <button
      className={`model-choice ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      onClick={() => onSelect(model.id)}
      type="button"
    >
      <span className="model-choice-icon">
        <ModelIcon size={17} />
      </span>
      <span className="model-choice-copy">
        <span className="model-choice-name">{model.name}</span>
      </span>
      {selected && <Check size={17} className="model-choice-check" />}
    </button>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? "on" : ""}`}
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

function NewTaskModal({ onClose, onCreate, onNotice }) {
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [title, setTitle] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const titleRef = useRef(null);

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

      onNotice("请在 Electron 桌面端选择工作目录。");
    } catch (error) {
      if (error?.name !== "AbortError") {
        onNotice("无法读取所选目录，请重试。");
      }
    } finally {
      setSelectingFolder(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!workspacePath && !trimmedTitle) return;
    onCreate({
      ...config,
      title:
        trimmedTitle ||
        (workspaceName ? `${workspaceName} 中的新任务` : "新任务"),
      workspacePath: workspacePath || null,
      workspaceName: workspaceName || "无工作区",
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
          <h2>新建任务</h2>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="modal-body">
          <section className="form-section">
            <label className="field-label">工作目录</label>
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
                    (selectingFolder ? "正在打开目录…" : "选择一个本地文件夹")}
                </span>
                {workspacePath && <small>{workspacePath}</small>}
              </span>
              <span className="workspace-picker-action">
                {workspacePath ? "更改" : "浏览"}
              </span>
            </button>
          </section>

          <section className="form-section">
            <label className="field-label" htmlFor="task-title">
              任务名称 <span>可选</span>
            </label>
            <input
              id="task-title"
              ref={titleRef}
              className="text-field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={
                workspaceName ? `${workspaceName} 中的新任务` : "例如：实现登录页面"
              }
              maxLength={80}
            />
          </section>

          <section className="form-section">
            <label className="field-label">模型</label>
            <div className="model-grid">
              {MODELS.map((model) => (
                <ModelChoice
                  key={model.id}
                  model={model}
                  selected={config.modelId === model.id}
                  onSelect={(modelId) =>
                    setConfig((current) => ({ ...current, modelId }))
                  }
                />
              ))}
            </div>
          </section>

          <section className="form-section configuration-card">
            <div className="config-row">
              <div className="config-copy">
                <div className="config-title">
                  <Brain size={16} />
                  <span>深度思考</span>
                </div>
              </div>
              <Switch
                checked={config.thinking}
                label="深度思考"
                onChange={(thinking) =>
                  setConfig((current) => ({ ...current, thinking }))
                }
              />
            </div>

            {config.thinking && (
              <div className="config-row bordered">
                <div className="config-copy">
                  <div className="config-title">思考强度</div>
                </div>
                <SegmentedControl
                  value={config.effort}
                  ariaLabel="思考强度"
                  options={[
                    { value: "high", label: "High" },
                    { value: "max", label: "Max" },
                  ]}
                  onChange={(effort) =>
                    setConfig((current) => ({ ...current, effort }))
                  }
                />
              </div>
            )}
          </section>

          <section className="form-section">
            <label className="field-label">文件权限</label>
            <SegmentedControl
              value={config.permission}
              ariaLabel="文件权限"
              options={[
                { value: "read-only", label: "只读" },
                { value: "workspace-write", label: "工作区读写" },
              ]}
              onChange={(permission) =>
                setConfig((current) => ({ ...current, permission }))
              }
            />
          </section>
        </div>

        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={!workspacePath && !title.trim()}
          >
            创建任务
          </button>
        </div>
      </form>
    </div>
  );
}

function EmptyState({ onNewTask }) {
  return (
    <main className="empty-state">
      <h1>从一个疑问开始。</h1>
      <p>
        写代码、制作文档、演示文稿与表格。告诉 AporiaX，你想抵达哪里。
      </p>
      <button className="primary-button large" onClick={onNewTask}>
        <Plus size={17} />
        新建任务
      </button>
      <div className="empty-state-meta">
        <span>
          <HardDrive size={14} />
          本地工作区
        </span>
        <span>
          <LockKeyhole size={14} />
          权限可控
        </span>
      </div>
    </main>
  );
}

function ModelMenu({ task, onUpdate, onClose }) {
  const menuRef = useRef(null);

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
      <div className="model-menu-heading">选择模型</div>
      <div className="model-menu-options">
        {MODELS.map((model) => (
          <ModelChoice
            key={model.id}
            compact
            model={model}
            selected={task.modelId === model.id}
            onSelect={(modelId) => onUpdate({ modelId })}
          />
        ))}
      </div>
      <div className="model-menu-divider" />
      <div className="model-menu-row">
        <div>
          <span className="model-menu-label">深度思考</span>
          <small>先规划再执行</small>
        </div>
        <Switch
          checked={task.thinking}
          label="深度思考"
          onChange={(thinking) => onUpdate({ thinking })}
        />
      </div>
      {task.thinking && (
        <div className="model-menu-row">
          <span className="model-menu-label">思考强度</span>
          <SegmentedControl
            value={task.effort}
            ariaLabel="思考强度"
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
  onSend,
  onStop,
  onUpdateTask,
  onNotice,
  isRunning,
}) {
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const model = getModel(task.modelId);

  const send = () => {
    const content = message.trim();
    if (
      (!content && !attachments.length) ||
      isRunning ||
      attachmentLoading
    ) {
      return;
    }
    if (attachments.some(isImageAttachment) && !model.supportsImages) {
      onNotice(`${model.shortName} 当前仅支持文字，不能读取图片`);
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
      onNotice(`${model.shortName} 当前仅支持文字；识图需要接入视觉模型或 OCR`);
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
      onNotice(`图片不能超过 8 MB：${oversized.name}`);
      return;
    }
    try {
      const images = await Promise.all(candidates.map(readImageFile));
      setAttachments((current) => [...current, ...images].slice(0, 6));
    } catch (error) {
      onNotice(error?.message || "无法读取图片");
    }
  };

  const addDocumentFiles = async (fileList) => {
    if (!window.desktop?.attachments?.parse) {
      onNotice("附件解析能力不可用，请重启 AporiaX 桌面端");
      return;
    }
    const remaining = Math.max(0, 6 - attachments.length);
    const candidates = [...(fileList || [])]
      .filter((file) => !file.type.startsWith("image/"))
      .slice(0, remaining);
    if (!candidates.length) {
      if (remaining === 0) onNotice("每条消息最多添加 6 个附件");
      return;
    }
    const oversized = candidates.find((file) => file.size > 8_000_000);
    if (oversized) {
      onNotice(`附件不能超过 8 MB：${oversized.name}`);
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
          ? `已解析 ${parsed.length} 个附件，其中 ${ocrCount} 个 PDF 可能需要 OCR`
          : `已解析 ${parsed.length} 个附件`,
      );
    } catch (error) {
      const cleanMessage = String(error?.message || "无法解析附件")
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
        if (isRunning) return;
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
                      {attachment.format || "文件"}
                      {Number.isInteger(attachment.pageCount)
                        ? ` · ${attachment.pageCount} 页`
                        : ""}
                      {attachment.requiresOcr
                        ? " · 需要 OCR"
                        : ` · ${formatAttachmentSize(attachment.size)}`}
                    </small>
                  </span>
                  <button
                    type="button"
                    aria-label={`移除 ${attachment.name}`}
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
                    aria-label={`移除 ${attachment.name}`}
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
          placeholder="描述你想完成的任务"
          rows={1}
          aria-label="任务输入"
          disabled={isRunning}
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
                  ? "添加图片"
                  : "当前模型不支持图片"
              }
              title={
                model.supportsImages
                  ? "添加图片"
                  : "当前模型仅支持文字，识图需要视觉模型或 OCR"
              }
              type="button"
              disabled={isRunning}
              onClick={() => {
                if (!model.supportsImages) {
                  onNotice(
                    `${model.shortName} 当前仅支持文字；识图需要接入视觉模型或 OCR`,
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
              aria-label="添加附件"
              title="添加附件（PDF、Office、Markdown、文本或代码）"
              type="button"
              disabled={isRunning || attachmentLoading}
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
          <button
            className={`send-button ${isRunning ? "stop" : ""}`}
            aria-label={isRunning ? "停止任务" : "发送"}
            title={isRunning ? "停止任务" : "发送"}
            disabled={
              isRunning
                ? false
                : attachmentLoading ||
                  (!message.trim() && !attachments.length)
            }
            onClick={isRunning ? onStop : send}
          >
            {isRunning ? (
              <Square size={13} fill="currentColor" />
            ) : (
              <ArrowUp size={17} />
            )}
          </button>
        </div>
      </div>
      <p className="composer-hint">
        {isRunning
          ? "任务运行中 · 点击停止按钮可安全中断"
          : model.supportsImages
            ? "Enter 发送 · Shift Enter 换行 · 可添加图片、PDF、文档与代码"
            : "Enter 发送 · Shift Enter 换行 · 可添加 PDF、文档与代码附件"}
      </p>
    </div>
  );
}

function MarkdownCodeBlock({ children }) {
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
          {copied ? "已复制" : "复制"}
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

function EditedFilesCard({
  files,
  hasSnapshots,
  confirmed,
  onReview,
}) {
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
            <strong>已编辑 {files.length} 个文件</strong>
            {hasLineStats ? (
              <span>
                <b className="diff-add">+{additions}</b>
                <b className="diff-delete">-{deletions}</b>
              </span>
            ) : (
              <span className="legacy-edit-note">
                {officeFiles.length
                  ? `${officeFiles.length} 个 Office 工件 · 可审核撤销`
                  : "历史记录 · 无行数统计"}
              </span>
            )}
          </div>
        </div>
        <div className="edited-files-actions">
          {confirmed && (
            <span className="edited-files-confirmed">
              <Check size={12} />
              已确认
            </span>
          )}
          <button
            className="review-files-button"
            type="button"
            onClick={() =>
              hasSnapshots
                ? onReview()
                : setExpanded((open) => !open)
            }
          >
            {hasSnapshots ? "审核" : expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>
      <div className="edited-file-list">
        {visibleFiles.map((file) => (
          <div className="edited-file-row" key={file.path}>
            <span className="edited-file-name">
              <FileIcon path={file.path} />
              <span title={file.path}>{file.path}</span>
              {file.created && <em>新增</em>}
              {file.reverted && <em className="reverted">已撤销</em>}
            </span>
            {file.reverted ? (
              <span className="legacy-file-status">检查点已恢复</span>
            ) : file.legacy ? (
              <span className="legacy-file-status">已创建</span>
            ) : file.binary ? (
              <span className="office-file-status">
                {file.artifact?.label || "Office 工件"}
              </span>
            ) : (
              <span className="edited-file-diff">
                <b className="diff-add">+{file.additions}</b>
                <b className="diff-delete">-{file.deletions}</b>
              </span>
            )}
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          className="show-more-files"
          type="button"
          onClick={() => setExpanded(true)}
        >
          再显示 {hiddenCount} 个文件
          <ChevronDown size={14} />
        </button>
      )}
    </section>
  );
}

function SelfCheckCard({ selfCheck }) {
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
          <strong>强制自检已完成</strong>
          <span>
            已复核 {reviewedCount} 个文件
            {improvementCount > 0
              ? `，自检中完成 ${improvementCount} 项改进`
              : "，未发现必须继续修改的问题"}
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
              ? "项目验证已通过"
              : verification.attempted
                ? "项目验证未通过"
                : "项目验证未执行"}
          </strong>
          <span>
            {verification.results?.length
              ? verification.results
                  .map(
                    (result) =>
                      `${result.command}${result.exitCode === null ? "" : `（退出码 ${result.exitCode}）`}`,
                  )
                  .join("；")
              : "Harness 已发现验证脚本，但没有可用结果。"}
          </span>
        </div>
      )}
      {remainingRisks.length > 0 && (
        <details>
          <summary>仍需人工确认 {remainingRisks.length} 项</summary>
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
  const failed = message.error || message.status === "failed";
  const interrupted = message.status === "interrupted";

  return (
    <article
      className={`assistant-message ${failed ? "error" : ""} ${interrupted ? "interrupted" : ""}`}
    >
      <div className="assistant-message-heading">
        <strong>
          {failed
            ? "运行失败"
            : interrupted
              ? "任务已停止"
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
          <span className="stream-placeholder">正在生成回复…</span>
        )}
      </div>
      {(failed || interrupted) && message.prompt && (
        <button
          className="retry-message-button"
          type="button"
          onClick={() => onRetry(message)}
        >
          <RotateCcw size={13} />
          重试本轮
        </button>
      )}
    </article>
  );
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
}) {
  const [reviewMessageId, setReviewMessageId] = useState(null);
  const [reverting, setReverting] = useState(false);
  const reviewMessage = task.messages.find(
    (message) => message.id === reviewMessageId,
  );

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
        <h2>从这里，穿过不确定性。</h2>
        <p>
          描述你想抵达的结果。AporiaX
          会规划路径、留下证据，并为关键修改保留回退锚点。
        </p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {task.messages.map((message) => {
        if (message.role === "user") {
          return (
          <article className="user-message" key={message.id}>
            {message.content && (
              <div className="message-bubble">{message.content}</div>
            )}
            <UserAttachments attachments={message.attachments} />
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
                onReview={() => setReviewMessageId(message.id)}
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
          <LoaderCircle className="spin" size={16} />
          <div>
            <strong>{runStatus?.title || "Harness 正在运行"}</strong>
            <p>
              {runStatus?.detail ||
                "模型正在检查授权工作区并规划下一步。"}
            </p>
          </div>
        </div>
      )}
      {reviewMessage?.changes?.length > 0 && (
        <DiffReviewPanel
          changes={reviewMessage.changes}
          confirmed={Boolean(reviewMessage.reviewConfirmedAt)}
          reverting={reverting}
          onClose={() => setReviewMessageId(null)}
          onConfirm={() => onConfirmChanges(reviewMessage.id)}
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
}) {
  const runs = collectTaskRouteRuns(task);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [review, setReview] = useState(null);
  const [reverting, setReverting] = useState(false);
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) || runs.at(-1);
  const entries = selectedRun?.entries || [];
  const completedCount = entries.filter((entry) =>
    ["completed", "skipped", "retry", "recovered"].includes(
      entry.status,
    ),
  ).length;
  const selectedRunIndex = Math.max(
    0,
    runs.findIndex((run) => run.id === selectedRun?.id),
  );
  const reviewRun = runs.find((run) => run.id === review?.runId);
  const reviewChanges = (reviewRun?.changes || []).filter(
    (change) => !review?.paths?.length || review.paths.includes(change.path),
  );

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
        <h2>行动路径尚未展开。</h2>
        <p>任务开始执行后，真实的观察、修改与验证会依次出现在这里。</p>
      </div>
    );
  }

  return (
    <>
      <div className="route-view">
        <header className="route-overview">
          <div>
            <span className="route-kicker">
              Route · 第 {selectedRunIndex + 1} 次任务
            </span>
            <h2>{selectedRun?.prompt || task.title}</h2>
          </div>
          <div className="route-overview-actions">
            {runs.length > 1 && (
              <label className="route-run-picker">
                <span>任务轮次</span>
                <select
                  value={selectedRun?.id || ""}
                  onChange={(event) => {
                    setSelectedRunId(event.target.value);
                    setReview(null);
                  }}
                >
                  {runs.map((run, index) => (
                    <option value={run.id} key={run.id}>
                      {String(index + 1).padStart(2, "0")} · {run.prompt}
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
                ? "执行中"
                : `${completedCount}/${entries.length} 步完成`}
            </div>
          </div>
        </header>

        <div className="route-step-list">
          {entries.map((entry, index) => {
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
              (entry.exitCode === 0 ? "命令执行成功" : "Harness 行动记录");
            const statusText =
              entry.status === "running"
                ? "正在执行"
                : entry.status === "waiting"
                  ? "等待批准"
                  : entry.status === "skipped"
                    ? "不适用"
                    : entry.status === "retry"
                      ? entry.tool === "complete_self_check"
                        ? "已转入补检"
                        : "等待重试"
                      : entry.status === "recovered"
                        ? "已重试成功"
                        : entry.status === "failed"
                          ? "未完成"
                          : duration || "完成";
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
                    <strong>{entry.title}</strong>
                    <span title={detail}>{detail}</span>
                  </span>
                  <em>{statusText}</em>
                  <ChevronDown size={15} />
                </summary>
                <div className="route-step-detail">
                  {entry.tool && (
                    <div>
                      <span>工具</span>
                      <code>{entry.tool}</code>
                    </div>
                  )}
                  {entry.path && (
                    <div>
                      <span>文件</span>
                      <code>{entry.path}</code>
                    </div>
                  )}
                  {entry.command && (
                    <div>
                      <span>命令</span>
                      <code>{entry.command}</code>
                    </div>
                  )}
                  {(entry.additions > 0 || entry.deletions > 0) && (
                    <div>
                      <span>修改</span>
                      <p className="route-change-count">
                        <b>+{entry.additions || 0}</b>
                        <i>-{entry.deletions || 0}</i>
                      </p>
                    </div>
                  )}
                  {artifact && (
                    <div>
                      <span>产物</span>
                      <p>
                        {artifact.label || getDeliverableType({ path: entry.path || "" })}
                      </p>
                    </div>
                  )}
                  {entry.detail && (
                    <div>
                      <span>结果</span>
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
                        })
                      }
                    >
                      查看具体修改
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
          onClose={() => setReview(null)}
          onRevert={revertChanges}
        />
      )}
    </>
  );
}

function SettingsPanel({
  task,
  onClose,
  apiConfigured,
  onManageApiKey,
  onSelectWorkspace,
  style,
}) {
  return (
    <aside className="settings-panel" style={style}>
      <div className="settings-panel-header">
        <div>
          <span className="eyebrow">当前任务</span>
          <h2>任务设置</h2>
        </div>
        <IconButton label="关闭设置面板" onClick={onClose}>
          <PanelRightClose size={18} />
        </IconButton>
      </div>

      <section className="settings-section">
        <div className="settings-label">模型服务</div>
        <div className="api-status-row">
          <div className="api-status-copy">
            <span className={`api-status-dot ${apiConfigured ? "ready" : ""}`} />
            <div>
              <strong>
                {apiConfigured ? "DeepSeek 已连接" : "需要配置 API Key"}
              </strong>
              <span>密钥由系统安全存储加密保管</span>
            </div>
          </div>
          <button className="settings-link" onClick={onManageApiKey}>
            {apiConfigured ? "管理" : "设置"}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-label">工作目录</div>
        <div className="workspace-summary">
          {task.workspacePath ? (
            <FolderOpen size={17} />
          ) : (
            <Folder size={17} />
          )}
          <div>
            <strong>{task.workspaceName}</strong>
            <span title={task.workspacePath || ""}>
              {task.workspacePath || "当前任务只能进行纯对话"}
            </span>
          </div>
        </div>
        <button
          className="workspace-settings-button"
          onClick={onSelectWorkspace}
        >
          {task.workspacePath ? "更改工作目录" : "绑定工作目录"}
        </button>
      </section>
    </aside>
  );
}

function RenameTaskModal({ task, onClose, onRename }) {
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
            <h2>重命名任务</h2>
            <p>任务记录和工作目录不会发生变化。</p>
          </div>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="api-key-body">
          <label className="field-label" htmlFor="rename-task-title">
            任务名称
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
            取消
          </button>
          <button className="primary-button" type="submit" disabled={!title.trim()}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

function PanelResizer({ panelName, width, minimum, maximum, onResize }) {
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
      aria-label={`调整${panelName}宽度`}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onDoubleClick={() =>
        onResize(
          panelName === "任务设置"
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

function TaskWorkspace({
  task,
  sidebarCollapsed,
  onToggleSidebar,
  settingsOpen,
  onToggleSettings,
  onSend,
  onStop,
  onRetry,
  onRevert,
  onConfirmChanges,
  runStatus,
  approval,
  approvalResponding,
  onRespondApproval,
  onUpdateTask,
  isRunning,
  apiConfigured,
  onManageApiKey,
  onSelectWorkspace,
  onNotice,
  theme,
  onToggleTheme,
}) {
  const [activeView, setActiveView] = useState("dialogue");
  const [workspaceFocusPath, setWorkspaceFocusPath] = useState("");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
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
  const model = getModel(task.modelId);
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
      onNotice("工作目录路径已复制");
    } catch {
      onNotice("无法复制工作目录路径");
    }
    setMoreMenuOpen(false);
  };

  const openWorkspace = async () => {
    if (!task.workspacePath || !window.desktop?.openWorkspace) {
      onNotice("当前工作目录无法在资源管理器中打开");
      return;
    }
    try {
      await window.desktop.openWorkspace(task.workspacePath);
    } catch {
      onNotice("无法打开工作目录");
    }
    setMoreMenuOpen(false);
  };

  return (
    <div className="task-workspace">
      <section className="thread">
        <header className="thread-header">
          <div className="thread-heading">
            <IconButton
              label={sidebarCollapsed ? "展开任务侧栏" : "收起任务侧栏"}
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
                  ? "浏览工作区文件"
                  : "绑定工作目录"
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
                  ? "切换为日间模式"
                  : "切换为夜间模式"
              }
              className={`theme-toggle ${theme === "dark" ? "active" : ""}`}
              onClick={onToggleTheme}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </IconButton>
            <IconButton
              label={settingsOpen ? "关闭任务设置" : "打开任务设置"}
              className={settingsOpen ? "active" : ""}
              onClick={() => {
                onToggleSettings();
              }}
            >
              <Settings2 size={18} />
            </IconButton>
            <div className="task-more-menu-wrap" ref={moreMenuRef}>
              <IconButton
                label="更多操作"
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
                    重命名任务
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!task.workspacePath}
                    onClick={showFilesPanel}
                  >
                    <Files size={15} />
                    文件与代码
                  </button>
                  <button type="button" role="menuitem" onClick={showSettingsPanel}>
                    <Settings2 size={15} />
                    任务设置
                  </button>
                  <div className="task-more-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!task.workspacePath}
                    onClick={copyWorkspacePath}
                  >
                    <Copy size={15} />
                    复制工作目录路径
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!task.workspacePath}
                    onClick={openWorkspace}
                  >
                    <HardDrive size={15} />
                    在资源管理器中打开
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <nav className="thread-view-tabs" aria-label="任务视图">
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
            />
          </div>
          <div
            className={`thread-view-panel route-panel ${
              activeView === "route" ? "active" : ""
            }`}
            aria-hidden={activeView !== "route"}
          >
            <RouteView
              task={task}
              isRunning={isRunning}
              runStatus={runStatus}
              approval={approval}
              approvalResponding={approvalResponding}
              onRespondApproval={onRespondApproval}
              onRevert={onRevert}
            />
          </div>
          <div
            className={`thread-view-panel workspace-panel ${
              activeView === "workspace" ? "active" : ""
            }`}
            aria-hidden={activeView !== "workspace"}
          >
            <FileExplorerPanel
              workspacePath={task.workspacePath}
              embedded
              initialPath={workspaceFocusPath}
              onNotice={onNotice}
            />
          </div>
        </div>

        <Composer
          task={task}
          onSend={onSend}
          onStop={onStop}
          onUpdateTask={onUpdateTask}
          onNotice={onNotice}
          isRunning={isRunning}
        />
      </section>

      {settingsOpen ? (
        <>
          <PanelResizer
            panelName="任务设置"
            width={settingsPanelWidth}
            minimum={260}
            maximum={620}
            onResize={setSettingsPanelWidth}
          />
          <SettingsPanel
            task={task}
            onClose={onToggleSettings}
            apiConfigured={apiConfigured}
            onManageApiKey={onManageApiKey}
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
            onNotice("任务已重命名");
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

function ApiKeyModal({
  configured,
  onClose,
  onSave,
  onClear,
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const submit = async (event) => {
    event.preventDefault();
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(apiKey);
      setApiKey("");
    } catch (saveError) {
      setError(saveError?.message || "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    setError("");
    try {
      await onClear();
    } catch (clearError) {
      setError(clearError?.message || "移除失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="api-key-modal" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <h2>DeepSeek API</h2>
            <p>密钥只会发送到 Electron 主进程并进行系统级加密。</p>
          </div>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="api-key-body">
          <div className="secure-key-note">
            <KeyRound size={17} />
            <div>
              <strong>
                {configured ? "当前已保存一个密钥" : "尚未配置密钥"}
              </strong>
              <span>前端不会读取、显示或保存密钥明文。</span>
            </div>
          </div>
          <label className="field-label" htmlFor="deepseek-api-key">
            {configured ? "替换 API Key" : "API Key"}
          </label>
          <input
            id="deepseek-api-key"
            ref={inputRef}
            className="text-field"
            type="password"
            autoComplete="off"
            spellCheck="false"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-••••••••••••••••"
          />
          {error && <p className="api-key-error">{error}</p>}
        </div>
        <div className="modal-footer api-key-footer">
          {configured && (
            <button
              className="danger-text-button"
              type="button"
              disabled={saving}
              onClick={clearKey}
            >
              <Trash2 size={14} />
              移除密钥
            </button>
          )}
          <div className="modal-footer-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={!apiKey.trim() || saving}
            >
              {saving && <LoaderCircle className="spin" size={14} />}
              安全保存
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function App() {
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
  const [apiConfigured, setApiConfigured] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const [runStatus, setRunStatus] = useState(null);
  const [approval, setApproval] = useState(null);
  const [approvalResponding, setApprovalResponding] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [theme, setTheme] = useState(readSavedTheme);
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const runsRef = useRef(new Map());
  const tasksRef = useRef(tasks);

  const activeTask = tasks.find((task) => task.id === activeTaskId) || null;

  useEffect(() => {
    tasksRef.current = tasks;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
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
        if (
          storedTasks === null ||
          (storedTasks.length === 0 && tasksRef.current.length > 0)
        ) {
          await window.desktop.tasks.save(tasksRef.current);
        } else {
          setTasks(storedTasks);
          setActiveTaskId(storedTasks[0]?.id || null);
        }
      } catch {
        if (active) setNotice("任务历史加载失败，已使用本地缓存");
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
        setNotice("任务检查点保存失败");
      });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [storageReady, tasks]);

  useEffect(() => {
    let active = true;
    window.desktop?.harness
      ?.hasApiKey()
      .then((configured) => {
        if (active) setApiConfigured(Boolean(configured));
      })
      .catch(() => {
        if (active) setApiConfigured(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!window.desktop?.harness?.onEvent) return undefined;
    const toolLabels = {
      list_directory: "正在浏览工作区",
      read_file: "正在读取文件",
      search_text: "正在搜索代码",
      git_status: "正在检查 Git 状态",
      git_diff: "正在读取代码差异",
      write_file: "正在修改文件",
      apply_patch: "正在精确修改代码",
      create_word_document: "正在生成 Word 文档",
      create_presentation: "正在生成 PowerPoint",
      create_spreadsheet: "正在生成 Excel 工作簿",
      inspect_office_file: "正在检查 Office 工件",
      run_command: "正在准备验证命令",
      complete_self_check: "正在提交自检报告",
    };
    return window.desktop.harness.onEvent((event) => {
      const run = runsRef.current.get(event.runId);
      if (!run) return;

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
              ? "AporiaX 正在强制自检"
              : "AporiaX 正在生成",
          detail:
            event.phase === "self-check"
              ? "正在重新读取本轮修改的代码并检查可改进项"
              : event.round > 1
                ? `正在处理第 ${event.round} 轮工具结果`
                : "正在理解任务并规划操作",
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
          title: `DeepSeek 正在自动重试 ${event.attempt}/${event.maxAttempts}`,
          detail: "请求暂时无响应或服务繁忙，已保留本轮任务状态",
        });
        return;
      }

      if (event.type === "context.compacted") {
        setRunStatus({
          title: "正在压缩长任务上下文",
          detail: `已压缩 ${event.compactedMessages || 0} 条旧工具输出，保留最近操作`,
        });
        return;
      }

      if (event.type === "tool.started") {
        const meta = getRouteToolMeta(event.tool, event.phase);
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
                status: "running",
                startedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: toolLabels[event.tool] || "Harness 正在运行",
          detail:
            event.tool === "run_command"
              ? "命令执行前会等待你的批准"
              : event.phase === "self-check"
                ? "强制复核本轮修改，发现问题会继续修复"
                : "操作范围限制在当前工作区内",
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
                      "后续重试已成功",
                  };
                }
              }
            }
            return { ...message, route };
          }),
        );
        setRunStatus({
          title: event.skipped
            ? "检查不适用于当前工作区"
            : event.retry
              ? event.tool === "complete_self_check"
                ? "自检条件尚未满足"
                : "工具参数将自动重试"
              : event.success
                ? "操作已完成"
                : "操作未完成",
          detail:
            event.detail ||
            (event.success
              ? "正在整理结果并决定下一步"
              : "Agent 正在根据错误调整方案"),
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
                title: "进入强制自检",
                detail: `复核 ${event.paths?.length || 0} 个修改文件`,
                status: "completed",
                startedAt: now,
                finishedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: "进入强制自检",
          detail: event.verificationCandidates?.length
            ? `复核 ${event.paths?.length || 0} 个文件，并尝试项目构建或测试`
            : `必须重新读取 ${event.paths?.length || 0} 个修改文件后才能完成任务`,
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
                title: "强制自检已完成",
                detail: event.report?.verification?.passed
                  ? "项目验证已通过"
                  : `已复核 ${event.report?.reviewedFiles?.length || 0} 个文件`,
                status: "completed",
                startedAt: now,
                finishedAt: now,
              },
            ],
          })),
        );
        setRunStatus({
          title: "强制自检已通过",
          detail: `已复核 ${event.report?.reviewedFiles?.length || 0} 个修改文件，正在整理最终答复`,
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
                      title: "整理最终产物",
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
          title: "等待命令审批",
          detail: "确认后 Harness 才会在本机执行该命令",
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setNewTaskOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const updateActiveTask = (patch) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === activeTaskId ? { ...task, ...patch } : task,
      ),
    );
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
    setNotice("任务已创建");
  };

  const sendMessage = (content, attachments = []) => {
    if (!window.desktop?.harness) {
      setNotice("请在 Electron 桌面端运行 Harness");
      return false;
    }
    if (!apiConfigured) {
      setApiKeyOpen(true);
      setNotice("请先安全保存 DeepSeek API Key");
      return false;
    }
    if (!activeTask || runningTaskId) return false;

    const runId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const userMessage = {
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
      prompt: content,
      sourceUserId: userMessage.id,
      steps: [],
      changes: [],
      route: [
        {
          id: `${runId}-route-start`,
          stage: "route",
          title: "理解任务并准备行动",
          status: "running",
          startedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };
    setTasks((current) =>
      current.map((task) =>
        task.id === activeTaskId
          ? {
              ...task,
              messages: [
                ...task.messages,
                userMessage,
                assistantMessage,
              ],
            }
          : task,
      ),
    );
    runsRef.current.set(runId, {
      taskId: activeTask.id,
      assistantId,
      routeCounter: 0,
    });
    setRunningTaskId(activeTask.id);
    setActiveRunId(runId);
    setApproval(null);
    setRunStatus({
      title: "正在启动 Harness",
      detail: "正在加载项目指令与任务上下文",
    });

    void window.desktop.harness
      .run({
        runId,
        workspacePath: activeTask.workspacePath,
        modelId: activeTask.modelId,
        thinking: activeTask.thinking,
        effort: activeTask.effort,
        permission: activeTask.permission,
        messages: [...activeTask.messages, userMessage],
      })
      .then((result) => {
        setTasks((current) =>
          current.map((task) =>
            task.id === activeTask.id
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
                          provider: result.provider || "deepseek",
                          tools: result.tools || [],
                          selfCheck: result.selfCheck || null,
                          completedAt: new Date().toISOString(),
                        }
                      : message,
                  ),
                }
              : task,
          ),
        );
        if (result.status === "failed") {
          setNotice("Harness 运行失败");
        } else if (result.status === "interrupted") {
          setNotice("任务已停止，已保留文件检查点");
        }
      })
      .catch((error) => {
        const cleanMessage = String(error?.message || "Harness 运行失败")
          .replace(/^Error invoking remote method '[^']+':\s*/i, "")
          .replace(/^Error:\s*/i, "");
        setTasks((current) =>
          current.map((task) =>
            task.id === activeTask.id
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
        setNotice("Harness 运行失败");
      })
      .finally(() => {
        runsRef.current.delete(runId);
        setRunningTaskId((current) =>
          current === activeTask.id ? null : current,
        );
        setActiveRunId((current) => (current === runId ? null : current));
        setApproval((current) =>
          current?.runId === runId ? null : current,
        );
        setRunStatus(null);
      });

    return true;
  };

  const stopActiveRun = async () => {
    if (!activeRunId || !window.desktop?.harness?.interrupt) return;
    setRunStatus({
      title: "正在停止任务",
      detail: "等待当前操作安全退出",
    });
    setApproval(null);
    try {
      await window.desktop.harness.interrupt(activeRunId);
    } catch {
      setNotice("无法停止任务，请稍后重试");
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
        setNotice("审批请求已经失效");
        return;
      }
      setApproval((current) =>
        current?.id === currentApproval.id ? null : current,
      );
      setRunStatus({
        title: approved ? "操作已批准" : "操作已拒绝",
        detail: approved
          ? "Harness 正在执行工具并收集结果"
          : "Agent 会根据拒绝结果调整方案",
      });
    } catch {
      setNotice("无法提交审批结果");
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
    if (retryImages.length && !getModel(task?.modelId).supportsImages) {
      setNotice("当前模型不支持识图，已移除图片并按文字内容重试");
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
      setNotice("桌面文件恢复能力不可用");
      return [];
    }
    const task = tasksRef.current.find((candidate) =>
      candidate.messages.some((message) => message.id === messageId),
    );
    const message = task?.messages.find(
      (candidate) => candidate.id === messageId,
    );
    if (!task?.workspacePath || !message?.changes?.length) {
      setNotice("没有可恢复的文件检查点");
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
        setNotice(
          `已撤销 ${revertedPaths.size} 个文件，${conflicts} 个文件因后续改动未覆盖`,
        );
      } else {
        setNotice(`已恢复 ${revertedPaths.size} 个文件检查点`);
      }
      return results;
    } catch (error) {
      const cleanMessage = String(error?.message || "撤销失败")
        .replace(/^Error invoking remote method '[^']+':\s*/i, "")
        .replace(/^Error:\s*/i, "");
      setNotice(cleanMessage);
      return [];
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
    setNotice("已确认保留上一轮修改");
  };

  const saveApiKey = async (apiKey) => {
    await window.desktop?.harness?.saveApiKey(apiKey);
    setApiConfigured(true);
    setApiKeyOpen(false);
    setNotice("DeepSeek API Key 已安全保存");
  };

  const clearApiKey = async () => {
    await window.desktop?.harness?.clearApiKey();
    setApiConfigured(false);
    setApiKeyOpen(false);
    setNotice("DeepSeek API Key 已移除");
  };

  const selectWorkspaceForActiveTask = async () => {
    if (!window.desktop?.selectDirectory) {
      setNotice("桌面桥未加载，请关闭旧窗口后重新启动 Electron");
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
      setNotice("工作目录已绑定");
    } catch {
      setNotice("无法打开目录选择器，请重启 Electron");
    }
  };

  const dismissWelcome = () => {
    setWelcomeOpen(false);
  };

  return (
    <div className="app-shell" data-theme={theme}>
      <AppTitlebar />
      <div className="app-content">
        {!sidebarCollapsed && (
          <Sidebar
            tasks={tasks}
            activeTaskId={activeTaskId}
            onSelectTask={setActiveTaskId}
            onNewTask={() => setNewTaskOpen(true)}
            searchOpen={searchOpen}
            onToggleSearch={() => setSearchOpen((open) => !open)}
          />
        )}

        <section className="main-surface">
          {!activeTask && (
            <div className="surface-toolbar">
              <IconButton
                label={sidebarCollapsed ? "展开任务侧栏" : "收起任务侧栏"}
                onClick={() => setSidebarCollapsed((current) => !current)}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen size={17} />
                ) : (
                  <PanelLeftClose size={17} />
                )}
              </IconButton>
              <span>工作区</span>
            </div>
          )}

          {activeTask ? (
            <TaskWorkspace
              task={activeTask}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() =>
                setSidebarCollapsed((current) => !current)
              }
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((open) => !open)}
              onSend={sendMessage}
              onStop={stopActiveRun}
              onRetry={retryMessage}
              onRevert={revertMessageChanges}
              onConfirmChanges={confirmMessageChanges}
              runStatus={runStatus}
              approval={
                approval?.taskId === activeTask.id ? approval : null
              }
              approvalResponding={approvalResponding}
              onRespondApproval={respondToApproval}
              onUpdateTask={updateActiveTask}
              isRunning={runningTaskId === activeTask.id}
              apiConfigured={apiConfigured}
              onManageApiKey={() => setApiKeyOpen(true)}
              onSelectWorkspace={selectWorkspaceForActiveTask}
              onNotice={setNotice}
              theme={theme}
              onToggleTheme={() =>
                setTheme((current) =>
                  current === "dark" ? "light" : "dark",
                )
              }
            />
          ) : (
            <EmptyState onNewTask={() => setNewTaskOpen(true)} />
          )}
        </section>
      </div>

      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreate={createTask}
          onNotice={setNotice}
        />
      )}
      {apiKeyOpen && (
        <ApiKeyModal
          configured={apiConfigured}
          onClose={() => setApiKeyOpen(false)}
          onSave={saveApiKey}
          onClear={clearApiKey}
        />
      )}
      {welcomeOpen && <WelcomeOverlay onContinue={dismissWelcome} />}
      <Toast message={notice} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
