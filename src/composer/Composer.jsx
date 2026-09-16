import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  FileText,
  ImagePlus,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Square,
  Users,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";
import { OcrDialog, ocrSource } from "../workbench/OcrDialog.jsx";
import { ModelChoice, SegmentedControl, Switch } from "../components/Controls.jsx";
import { getModel, getModelGroups } from "../models/model-catalog.js";
import { useWorkspaceMentionAutocomplete } from "./WorkspaceMentionAutocomplete.jsx";
import {
  attachmentImageSrc,
  beginComposerAttachmentDrag,
  endComposerAttachmentDrag,
  filePathOf,
  isComposerAttachmentDrag,
} from "../attachments.js";
import {
  BUILDER_COUNT_CHOICES,
  DEFAULT_BUILDER_LIMIT,
  normalizeBuilderCount,
} from "../../electron/harness/builder-count.js";

function ModelMenu({ task, providers, onUpdate, onClose }) {
  const { tr } = useI18n();
  const menuRef = useRef(null);
  const selectedModel = getModel(
    providers,
    task.providerId,
    task.modelId,
  );
  const modelGroups = getModelGroups(providers);

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
        {modelGroups.map((group, groupIndex) => (
          <div className="model-menu-source-group" key={group.source}>
            {groupIndex > 0 && <div className="model-menu-divider" />}
            <div className="model-menu-heading">
              {tr(group.titleZh, group.titleEn)}
            </div>
            <div className="model-menu-source-note">
              {tr(group.noteZh, group.noteEn)}
            </div>
            {group.models.map((model) => (
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

function BuilderCountMenu({ value, onChange, onClose }) {
  const { tr } = useI18n();
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
    <div className="builder-count-menu" ref={menuRef} role="menu">
      <div className="model-menu-heading">{tr("Builder 并发上限", "Concurrent Builders")}</div>
      <p className="builder-count-note">
        {tr("默认 2，按需调用；完成后释放名额，后续可继续分批。0 为关闭，较高并发会增加内存和模型费用。", "Default 2, on demand. Slots are reused across waves. 0 disables Builders; higher concurrency uses more memory and tokens.")}
      </p>
      {BUILDER_COUNT_CHOICES.map((count) => (
        <button
          className={`builder-count-option${value === count ? " selected" : ""}`}
          key={count}
          type="button"
          role="menuitemradio"
          aria-checked={value === count}
          onClick={() => {
            onChange(count);
            onClose();
          }}
        >
          {count === 0 ? tr("无", "None") : String(count)}
        </button>
      ))}
    </div>
  );
}

function bytesToDataUrl(type, bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${type || "image/png"};base64,${btoa(binary)}`;
}

async function storeImageFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const type = file.type || "image/png";
  let hash;
  if (window.desktop?.attachments?.store) {
    try {
      const stored = await window.desktop.attachments.store({
        type,
        data,
      });
      hash = stored.hash;
    } catch {
      // Persist will extract the in-memory data URL later.
    }
  }
  return {
    id: crypto.randomUUID(),
    kind: "image",
    name: file.name,
    type,
    size: file.size,
    hash,
    path: filePathOf(file),
    dataUrl: bytesToDataUrl(type, data),
  };
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

export function isImageAttachment(attachment) {
  if (!attachment || attachment.kind === "document") return false;
  return (
    attachment.kind === "image" ||
    typeof attachment.dataUrl === "string" ||
    (typeof attachment.hash === "string" &&
      String(attachment.type || "").startsWith("image/"))
  );
}

function formatAttachmentSize(size) {
  if (!Number.isFinite(size)) return "";
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${(size / 1_000).toFixed(1)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

export function Composer({
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
  const [ocr, setOcr] = useState(null);
  useEffect(() => { setOcr(null); }, [task.id]);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [builderMenuOpen, setBuilderMenuOpen] = useState(false);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const model = getModel(
    providers,
    task.providerId,
    task.modelId,
  );
  const builderLimit = normalizeBuilderCount(task.builderLimit, DEFAULT_BUILDER_LIMIT);
  const mentionAutocomplete = useWorkspaceMentionAutocomplete({
    value: message,
    setValue: setMessage,
    textareaRef,
    workspacePath: task.workspacePath || "",
  });

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
      const images = await Promise.all(candidates.map(storeImageFile));
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
          path: filePathOf(file),
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
    if (mentionAutocomplete.handleKeyDown(event)) return;
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
      onDragOver={(event) => {
        if (isComposerAttachmentDrag(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "none";
          return;
        }
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (isComposerAttachmentDrag(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
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
                  draggable
                  onDragStart={(event) => {
                    beginComposerAttachmentDrag(event, attachment);
                  }}
                  onDragEnd={endComposerAttachmentDrag}
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
                  {attachment.format === "PDF" && window.desktop?.ocr && <button type="button" aria-label={tr("识别 PDF 文字", "Recognize PDF text")} onClick={() => setOcr({ source: ocrSource(attachment) })}>OCR</button>}
                  <button
                    type="button"
                    aria-label={tr("移除 {name}", "Remove {name}", { name: attachment.name })}
                    onPointerDown={(event) => event.stopPropagation()}
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
                <figure
                  key={attachment.id}
                  draggable
                  onDragStart={(event) => {
                    beginComposerAttachmentDrag(event, attachment);
                  }}
                  onDragEnd={endComposerAttachmentDrag}
                >
                  <img src={attachmentImageSrc(attachment)} alt={attachment.name} draggable={false} />
                  <figcaption>{attachment.name}</figcaption>
                  {window.desktop?.ocr && <button type="button" className="composer-ocr-button" aria-label={tr("识别图片文字", "Recognize image text")} onClick={() => setOcr({ source: ocrSource(attachment) })}>OCR</button>}
                  <button
                    type="button"
                    aria-label={tr("移除 {name}", "Remove {name}", { name: attachment.name })}
                    onPointerDown={(event) => event.stopPropagation()}
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
        {mentionAutocomplete.menu}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={resizeTextarea}
          onKeyDown={handleKeyDown}
          onClick={mentionAutocomplete.refreshCursor}
          onKeyUp={mentionAutocomplete.refreshCursor}
          onPaste={handlePaste}
          placeholder={tr("描述你想完成的任务", "Describe what you want to accomplish")}
          rows={1}
          aria-label={tr("任务输入", "Task prompt")}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            {window.desktop?.ocr && <button type="button" className="composer-add" title={tr("本地识别图片 / PDF 文字", "Local image / PDF OCR")} aria-label={tr("本地文字识别", "Local OCR")} onClick={() => setOcr({ source: null })}><span style={{ fontSize: 10 }}>OCR</span></button>}
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
                  setBuilderMenuOpen(false);
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
            <div className="builder-control">
              {builderMenuOpen && (
                <BuilderCountMenu
                  value={builderLimit}
                  onClose={() => setBuilderMenuOpen(false)}
                  onChange={(count) => onUpdateTask({ builderLimit: count })}
                />
              )}
              <button
                className={`builder-trigger ${builderMenuOpen ? "active" : ""}`}
                type="button"
                aria-label={tr("Builder 数量", "Builder count")}
                title={tr("Builder 数量", "Builder count")}
                onClick={(event) => {
                  event.stopPropagation();
                  setModelMenuOpen(false);
                  setBuilderMenuOpen((open) => !open);
                }}
              >
                <Users size={15} />
                <span>{builderLimit === 0 ? tr("无", "None") : builderLimit}</span>
                {isRunning && task.builderActivity && <small title={tr("运行中 / 排队", "Running / queued")}>{task.builderActivity.running}/{task.builderActivity.queued}</small>}
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
      {ocr && <OcrDialog key={task.id} source={ocr.source} onClose={() => setOcr(null)} onAttach={(attachment) => {
        if (attachments.length >= 6) { onNotice(tr("附件已满，请先移除一个附件。", "Remove an attachment first; limit is six.")); return false; }
        setAttachments((current) => current.length >= 6 ? current : [...current, attachment]);
        return true;
      }} />}
    </div>
  );
}
