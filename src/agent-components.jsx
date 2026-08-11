import React, { useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Save,
  Search,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import { useI18n } from "./i18n";

const CODE_EXTENSIONS = new Set([
  "c",
  "cpp",
  "cs",
  "css",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "py",
  "rs",
  "ts",
  "tsx",
  "vue",
]);

function extensionOf(path) {
  return path.split(".").at(-1)?.toLowerCase() || "";
}

function FileGlyph({ path, size = 15 }) {
  return CODE_EXTENSIONS.has(extensionOf(path)) ? (
    <FileCode2 size={size} />
  ) : (
    <FileText size={size} />
  );
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function OfficeArtifactReview({ change }) {
  const { tr } = useI18n();
  const artifact = change.artifact || {};
  const inspectedSlideRuns = artifact.slides?.reduce(
    (total, slide) => total + (Number(slide.textRuns) || 0),
    0,
  );
  const inspectedRows = artifact.sheets?.reduce(
    (total, sheet) => total + (Number(sheet.rowCount) || 0),
    0,
  );
  const metrics =
    artifact.kind === "document"
      ? [
          [tr("内容块", "Content blocks"), artifact.blockCount ?? artifact.paragraphCount],
          [tr("段落", "Paragraphs"), artifact.paragraphCount],
          [tr("表格", "Tables"), artifact.tableCount],
        ]
      : artifact.kind === "presentation"
        ? [
            [tr("幻灯片", "Slides"), artifact.slideCount],
            [tr("文本项", "Text items"), artifact.bulletCount ?? inspectedSlideRuns],
            [tr("布局提醒", "Layout warnings"), artifact.warnings?.length || 0],
          ]
        : [
            [tr("工作表", "Worksheets"), artifact.sheetCount],
            [tr("数据行", "Data rows"), artifact.rowCount ?? inspectedRows],
            [tr("公式", "Formulas"), artifact.formulaCount],
          ];

  return (
    <div className="office-artifact-review">
      <div className="office-artifact-summary">
        <span className="office-artifact-icon">
          <FileText size={22} />
        </span>
        <div>
          <strong>{artifact.label || tr("Office 工件", "Office artifact")}</strong>
          <span>
            {artifact.title || change.path} · {formatBytes(artifact.bytes)}
          </span>
        </div>
        <em>
          <Check size={13} />
          {tr("结构已生成", "Structure generated")}
        </em>
      </div>
      <div className="office-artifact-metrics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{Number(value) || 0}</strong>
          </div>
        ))}
      </div>
      <div className="office-visual-warning">
        <AlertTriangle size={16} />
        <div>
          <strong>{tr("尚未完成视觉渲染检查", "Visual rendering has not been verified")}</strong>
          <span>
            {tr(
              "Harness 已验证文件包可以解析；最终分页、字体、图表和版式仍建议在 Office 中打开确认。",
              "Harness verified that the package is readable. Open it in Office to confirm final pagination, fonts, charts, and layout.",
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function estimateBase64Bytes(content) {
  if (!content) return 0;
  const padding = content.endsWith("==")
    ? 2
    : content.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((content.length * 3) / 4) - padding);
}

function BinaryCheckpointReview({ change }) {
  const { tr } = useI18n();
  const beforeBytes = change.beforeMissing
    ? 0
    : estimateBase64Bytes(change.beforeContent);
  const afterBytes = change.afterMissing
    ? 0
    : estimateBase64Bytes(change.afterContent);
  return (
    <div className="binary-checkpoint-review">
      <span className="binary-checkpoint-icon">
        <FileText size={22} />
      </span>
      <div>
        <strong>
          {change.deleted || change.afterMissing
            ? tr("二进制文件已删除", "Binary file deleted")
            : change.created || change.beforeMissing
              ? tr("二进制文件已创建", "Binary file created")
              : tr("二进制快照", "Binary snapshot")}
        </strong>
        <span>{change.path}</span>
      </div>
      <dl>
        <div>
          <dt>{tr("之前", "Before")}</dt>
          <dd>
            {change.beforeMissing
              ? tr("不存在", "Missing")
              : formatBytes(beforeBytes)}
          </dd>
        </div>
        <div>
          <dt>{tr("之后", "After")}</dt>
          <dd>
            {change.afterMissing
              ? tr("已删除", "Deleted")
              : formatBytes(afterBytes)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function UserAttachments({ attachments }) {
  const { tr } = useI18n();
  if (!attachments?.length) return null;
  return (
    <div className="message-attachment-grid">
      {attachments.map((attachment) =>
        attachment.kind === "document" ? (
          <div
            className="message-document-attachment"
            key={attachment.id || attachment.name}
          >
            <span className="attachment-file-icon">
              <FileGlyph path={attachment.name} size={16} />
            </span>
            <span>
              <strong>{attachment.name || tr("未命名附件", "Untitled attachment")}</strong>
              <small>
                {attachment.format || tr("文件", "File")}
                {Number.isInteger(attachment.pageCount)
                  ? tr(" · {count} 页", " · {count} pages", { count: attachment.pageCount })
                  : ""}
                {attachment.requiresOcr
                  ? tr(" · 需要 OCR", " · OCR required")
                  : tr(" · 已解析", " · Parsed")}
              </small>
            </span>
          </div>
        ) : (
          <figure key={attachment.id || attachment.name}>
            <img
              src={attachment.dataUrl}
              alt={attachment.name || tr("图片附件", "Image attachment")}
            />
            <figcaption>{attachment.name || tr("图片", "Image")}</figcaption>
          </figure>
        ),
      )}
    </div>
  );
}

export function ApprovalCard({ approval, onRespond, responding }) {
  const { tr } = useI18n();
  if (!approval) return null;
  return (
    <section className="approval-card">
      <div className="approval-card-heading">
        <span>
          <Terminal size={16} />
        </span>
        <div>
          <strong>{approval.title || tr("需要批准", "Approval required")}</strong>
          <p>{approval.reason}</p>
        </div>
      </div>
      <div className="approval-command">
        <code>{approval.command}</code>
        <span>{tr("工作目录：{path}", "Working directory: {path}", { path: approval.cwd || "." })}</span>
      </div>
      <div className="approval-warning">
        {approval.kind === "execute" &&
        approval.sandbox?.available ? (
          <LockKeyhole size={14} />
        ) : (
          <AlertTriangle size={14} />
        )}
        {approval.kind === "execute"
          ? approval.sandbox?.available
            ? tr(
                "命令将在一次性 OS 容器中运行：默认断网、根文件系统只读，仅当前工作区可写。",
                "The command will run in an ephemeral OS container: offline by default, read-only root filesystem, with write access only to this workspace.",
              )
            : tr(
                "Docker 沙箱不可用：本次命令将在本机运行，可访问主机网络且不具备 OS 隔离。请逐字检查后再批准。",
                "Docker is unavailable. This command will run on the host with network access and no OS isolation. Review it carefully before approving.",
              )
          : tr(
              "此工具将访问或修改当前工作区，请确认本次操作符合预期。",
              "This tool will access or modify the current workspace. Confirm that the action is expected.",
            )}
      </div>
      {approval.kind === "execute" && (
        <div className="approval-sandbox-facts">
          {approval.sandbox?.available ? (
            <>
              <span>{approval.sandbox.backend}</span>
              <span>{tr("网络：关闭", "Network: off")}</span>
              <span>{tr("内存：{value}", "Memory: {value}", { value: approval.sandbox.memory })}</span>
              <span>{tr("进程：{value}", "Processes: {value}", { value: approval.sandbox.pidsLimit })}</span>
            </>
          ) : (
            <>
              <span>{tr("本机回退", "Host fallback")}</span>
              <span>{tr("强制逐条审批", "Approval required each time")}</span>
              <span>{tr("网络：可用", "Network: available")}</span>
              <span>{tr("敏感环境变量：移除", "Sensitive environment variables: removed")}</span>
            </>
          )}
        </div>
      )}
      <div className="approval-actions">
        <button
          type="button"
          disabled={responding}
          onClick={() => onRespond(false)}
        >
          {tr("拒绝", "Deny")}
        </button>
        <button
          className="approve"
          type="button"
          disabled={responding}
          onClick={() => onRespond(true, "once")}
        >
          {responding && <LoaderCircle className="spin" size={14} />}
          {tr("本次允许", "Allow once")}
        </button>
        {approval.canRememberForRun && (
          <button
            className="approve approval-run-grant"
            type="button"
            disabled={responding}
            onClick={() => onRespond(true, "run")}
          >
            {tr("本轮允许浏览器操作", "Allow browser controls for this task")}
          </button>
        )}
      </div>
    </section>
  );
}

function buildDiffRows(beforeContent, afterContent) {
  const rows = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const part of diffLines(beforeContent, afterContent)) {
    const rawLines = part.value.split("\n");
    if (rawLines.at(-1) === "") rawLines.pop();
    for (const line of rawLines) {
      if (part.added) {
        rows.push({
          type: "added",
          before: "",
          after: afterLine,
          content: line,
        });
        afterLine += 1;
      } else if (part.removed) {
        rows.push({
          type: "removed",
          before: beforeLine,
          after: "",
          content: line,
        });
        beforeLine += 1;
      } else {
        rows.push({
          type: "context",
          before: beforeLine,
          after: afterLine,
          content: line,
        });
        beforeLine += 1;
        afterLine += 1;
      }
    }
  }

  return rows;
}

export function DiffReviewPanel({
  changes,
  onClose,
  onRevert,
  reverting,
  confirmed = false,
  onConfirm,
  workspacePath = "",
  initialPath = "",
  initialMode = "diff",
  onSave,
  onNotice = () => {},
}) {
  const { tr } = useI18n();
  const availableChanges = changes || [];
  const [selectedPath, setSelectedPath] = useState(
    availableChanges.find((change) => change.path === initialPath)?.path ||
      availableChanges.find((change) => !change.reverted)?.path ||
      availableChanges[0]?.path ||
      "",
  );
  const [viewMode, setViewMode] = useState(initialMode);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewMeta, setPreviewMeta] = useState(null);
  const selected =
    availableChanges.find((change) => change.path === selectedPath) ||
    availableChanges[0];
  const rows = useMemo(
    () =>
      selected && !selected.binary
        ? buildDiffRows(selected.beforeContent, selected.afterContent)
        : [],
    [selected],
  );
  const activeChanges = availableChanges.filter(
    (change) => !change.reverted,
  );
  const editable = Boolean(
    selected &&
      workspacePath &&
      !selected.binary &&
      !selected.deleted &&
      !selected.afterMissing &&
      !previewMeta?.readOnly &&
      !previewMeta?.truncated,
  );
  const dirty = editable && editorContent !== savedContent;

  useEffect(() => {
    if (
      selected &&
      !selected.reverted &&
      availableChanges.some((change) => change.path === selected.path)
    ) {
      return;
    }
    setSelectedPath(
      availableChanges.find((change) => !change.reverted)?.path ||
        availableChanges[0]?.path ||
        "",
    );
  }, [availableChanges, selected]);

  useEffect(() => {
    if (
      !initialPath ||
      !availableChanges.some((change) => change.path === initialPath)
    ) {
      return;
    }
    setSelectedPath(initialPath);
  }, [availableChanges, initialPath]);

  useEffect(() => {
    let cancelled = false;
    setPreviewMeta(null);
    setEditorContent("");
    setSavedContent("");

    if (
      !selected ||
      selected.binary ||
      selected.deleted ||
      selected.afterMissing
    ) {
      if (viewMode === "edit") setViewMode("diff");
      return () => {
        cancelled = true;
      };
    }

    const fallbackContent = String(selected.afterContent || "");
    if (!workspacePath || !window.desktop?.workspace?.readPreview) {
      setEditorContent(fallbackContent);
      setSavedContent(fallbackContent);
      return () => {
        cancelled = true;
      };
    }

    setEditorLoading(true);
    void window.desktop.workspace
      .readPreview(workspacePath, selected.path)
      .then((result) => {
        if (cancelled) return;
        setPreviewMeta(result);
        const content = result.binary ? "" : String(result.content || "");
        setEditorContent(content);
        setSavedContent(content);
        if (result.binary && viewMode === "edit") setViewMode("diff");
      })
      .catch((error) => {
        if (cancelled) return;
        setEditorContent(fallbackContent);
        setSavedContent(fallbackContent);
        onNotice(
          error?.message ||
            tr(
              "无法读取当前文件，已显示检查点内容",
              "Unable to read the current file; showing checkpoint content instead",
            ),
        );
      })
      .finally(() => {
        if (!cancelled) setEditorLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selected?.path,
    selected?.binary,
    selected?.deleted,
    selected?.afterMissing,
    selected?.afterContent,
    workspacePath,
  ]);

  const saveSelectedFile = async () => {
    if (!selected || !editable || !dirty || saving) return;
    if (!window.desktop?.workspace?.saveText) {
      onNotice(
        tr(
          "当前桌面桥不支持保存，请重启 AporiaX",
          "The desktop bridge cannot save files. Restart AporiaX.",
        ),
      );
      return;
    }

    setSaving(true);
    try {
      const result = await window.desktop.workspace.saveText({
        workspacePath,
        requestedPath: selected.path,
        content: editorContent,
        expectedContent: savedContent,
      });
      setPreviewMeta((current) => ({ ...(current || {}), ...result }));
      setEditorContent(result.content);
      setSavedContent(result.content);
      onSave?.({
        path: selected.path,
        content: result.content,
        savedAt: result.savedAt,
      });
      onNotice(
        tr("已保存 {path}", "Saved {path}", { path: result.path }),
      );
    } catch (error) {
      onNotice(
        error?.message || tr("保存文件失败", "Failed to save the file"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="review-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="review-panel"
        aria-label={tr("文件变更审核", "File change review")}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            void saveSelectedFile();
          }
        }}
      >
        <header className="review-panel-header">
          <div>
            <GitCompare size={17} />
            <div>
              <strong>{tr("变更审核", "Change review")}</strong>
              <span>{tr("{count} 个文件检查点", "{count} file checkpoint(s)", { count: availableChanges.length })}</span>
            </div>
          </div>
          <button type="button" aria-label={tr("关闭审核", "Close review")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="review-panel-body">
          <aside className="review-file-list">
            {availableChanges.map((change) => (
              <button
                className={change.path === selected?.path ? "active" : ""}
                key={change.path}
                type="button"
                onClick={() => setSelectedPath(change.path)}
              >
                <FileGlyph path={change.path} />
                <span>{change.path}</span>
                {change.reverted ? (
                  <em className="reverted">
                    <Check size={12} />
                    {tr("已撤销", "Reverted")}
                  </em>
                ) : change.deleted || change.afterMissing ? (
                  <em className="deleted-change-kind">
                    {tr("已删除", "Deleted")}
                  </em>
                ) : change.binary ? (
                  <em className="office-change-kind">
                    {change.artifact?.label || tr("二进制", "Binary")}
                  </em>
                ) : (
                  <em>
                    <b>+{change.additions}</b>
                    <i>-{change.deletions}</i>
                  </em>
                )}
              </button>
            ))}
          </aside>

          <main className="diff-preview">
            {selected ? (
              <>
                <div className="diff-preview-header">
                  <div>
                    <FileGlyph path={selected.path} />
                    <strong>{selected.path}</strong>
                    {selected.created && <span>{tr("新增", "New")}</span>}
                    {(selected.deleted || selected.afterMissing) && (
                      <span className="deleted">
                        {tr("已删除", "Deleted")}
                      </span>
                    )}
                  </div>
                  <div className="diff-preview-actions">
                    {!selected.binary &&
                      !selected.deleted &&
                      !selected.afterMissing && (
                        <div
                          className="review-mode-switch"
                          role="group"
                          aria-label={tr("审核视图", "Review view")}
                        >
                          <button
                            className={viewMode === "diff" ? "active" : ""}
                            type="button"
                            onClick={() => setViewMode("diff")}
                          >
                            {tr("对比", "Diff")}
                          </button>
                          <button
                            className={viewMode === "edit" ? "active" : ""}
                            type="button"
                            disabled={!editable && Boolean(previewMeta)}
                            onClick={() => setViewMode("edit")}
                          >
                            {tr("编辑", "Edit")}
                          </button>
                        </div>
                      )}
                    <button
                      type="button"
                      disabled={selected.reverted || reverting}
                      onClick={() => onRevert([selected.path])}
                    >
                      <Undo2 size={14} />
                      {selected.reverted
                        ? tr("已撤销", "Reverted")
                        : tr("撤销此文件", "Revert this file")}
                    </button>
                  </div>
                </div>
                {selected.binary ? (
                  selected.artifact ? (
                    <OfficeArtifactReview change={selected} />
                  ) : (
                    <BinaryCheckpointReview change={selected} />
                  )
                ) : viewMode === "edit" ? (
                  editorLoading ? (
                    <div className="diff-empty">
                      <LoaderCircle className="spin" size={15} />
                      {tr("正在读取文件", "Loading file")}
                    </div>
                  ) : editable ? (
                    <textarea
                      className="review-code-editor"
                      value={editorContent}
                      onChange={(event) =>
                        setEditorContent(event.target.value)
                      }
                      spellCheck={false}
                      aria-label={tr("编辑 {path}", "Edit {path}", {
                        path: selected.path,
                      })}
                    />
                  ) : (
                    <div className="diff-empty">
                      {tr(
                        "此文件只能审核，不能作为文本安全编辑。",
                        "This file can be reviewed, but not safely edited as text.",
                      )}
                    </div>
                  )
                ) : (
                  <div className="diff-lines">
                    {rows.length ? (
                    rows.map((row, index) => (
                      <div
                        className={`diff-line ${row.type}`}
                        key={`${index}-${row.before}-${row.after}`}
                      >
                        <span>{row.before}</span>
                        <span>{row.after}</span>
                        <b>
                          {row.type === "added"
                            ? "+"
                            : row.type === "removed"
                              ? "-"
                              : " "}
                        </b>
                        <code>{row.content || " "}</code>
                      </div>
                    ))
                    ) : (
                      <div className="diff-empty">{tr("文件内容没有变化。", "File content is unchanged.")}</div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="diff-empty">{tr("没有可审核的文件。", "No files to review.")}</div>
            )}
          </main>
        </div>

        <footer className="review-panel-footer">
          <span>
            {viewMode === "edit" && editable
              ? dirty
                ? tr(
                    "有未保存的修改 · Ctrl+S 保存",
                    "Unsaved changes · Ctrl+S to save",
                  )
                : tr("文件内容已保存", "File content is saved")
              : tr(
                  "撤销前会检查文件是否在此检查点后被再次修改。",
                  "Before reverting, AporiaX checks whether the file changed after this checkpoint.",
                )}
          </span>
          <div>
            {viewMode === "edit" && editable && (
              <button
                className="save-review-button"
                type="button"
                disabled={!dirty || saving}
                onClick={() => void saveSelectedFile()}
              >
                {saving ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Save size={14} />
                )}
                {saving
                  ? tr("保存中", "Saving")
                  : tr("保存文件", "Save file")}
              </button>
            )}
            {onConfirm && (
              <button
                className="confirm-review-button"
                type="button"
                disabled={confirmed}
                onClick={onConfirm}
              >
                <Check size={14} />
                {confirmed
                  ? tr("本轮修改已确认", "Changes confirmed")
                  : tr("确认保留本轮修改", "Keep these changes")}
              </button>
            )}
            <button
              type="button"
              disabled={!activeChanges.length || reverting}
              onClick={() =>
                onRevert(activeChanges.map((change) => change.path))
              }
            >
              {reverting && <LoaderCircle className="spin" size={14} />}
              {tr("撤销本轮全部更改", "Revert all changes in this turn")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function FileExplorerPanel({
  workspacePath,
  onClose,
  onNotice,
  style,
  embedded = false,
  initialPath = "",
}) {
  const { tr } = useI18n();
  const [entriesByDirectory, setEntriesByDirectory] = useState({});
  const [expandedDirectories, setExpandedDirectories] = useState(
    () => new Set(),
  );
  const [loadingDirectories, setLoadingDirectories] = useState(
    () => new Set(),
  );
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const editable = Boolean(
    preview &&
      !preview.binary &&
      !preview.readOnly &&
      !preview.truncated,
  );
  const dirty = editable && editorContent !== savedContent;

  const loadDirectory = async (directory = ".", { reset = false } = {}) => {
    if (!workspacePath || !window.desktop?.workspace) {
      setEntriesByDirectory({});
      return [];
    }
    if (reset) {
      setEntriesByDirectory({});
      setExpandedDirectories(new Set());
    }
    setLoadingDirectories((current) => {
      const next = new Set(current);
      next.add(directory);
      return next;
    });
    try {
      const result = await window.desktop.workspace.listTree(
        workspacePath,
        directory,
      );
      const nextEntries = result.entries || [];
      setEntriesByDirectory((current) => ({
        ...current,
        [directory]: nextEntries,
      }));
      return nextEntries;
    } catch (error) {
      onNotice(error?.message || tr("无法读取工作区文件", "Unable to read workspace files"));
      return [];
    } finally {
      setLoadingDirectories((current) => {
        const next = new Set(current);
        next.delete(directory);
        return next;
      });
    }
  };

  const loadTree = () => loadDirectory(".", { reset: true });

  useEffect(() => {
    setSelectedPath("");
    setPreview(null);
    setEditorContent("");
    setSavedContent("");
    setEntriesByDirectory({});
    setExpandedDirectories(new Set());
    void loadTree();
  }, [workspacePath]);

  const visibleEntries = useMemo(() => {
    const output = [];
    const appendDirectory = (directory, depth) => {
      for (const entry of entriesByDirectory[directory] || []) {
        output.push({ ...entry, depth });
        if (
          entry.type === "directory" &&
          expandedDirectories.has(entry.path)
        ) {
          appendDirectory(entry.path, depth + 1);
        }
      }
    };
    appendDirectory(".", 0);
    return output;
  }, [entriesByDirectory, expandedDirectories]);

  const filteredEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return visibleEntries;
    const seen = new Set();
    return Object.values(entriesByDirectory)
      .flat()
      .filter((entry) => {
        if (
          seen.has(entry.path) ||
          !entry.path.toLowerCase().includes(keyword)
        ) {
          return false;
        }
        seen.add(entry.path);
        return true;
      })
      .map((entry) => ({ ...entry, depth: 0 }));
  }, [entriesByDirectory, query, visibleEntries]);

  const toggleDirectory = async (entry) => {
    if (expandedDirectories.has(entry.path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    if (!entriesByDirectory[entry.path]) {
      await loadDirectory(entry.path);
    }
    setExpandedDirectories((current) => {
      const next = new Set(current);
      next.add(entry.path);
      return next;
    });
  };

  const openFile = async (entry) => {
    if (entry.type !== "file") return;
    if (
      dirty &&
      entry.path !== selectedPath &&
      !window.confirm(tr("当前文件有未保存修改。放弃修改并打开其他文件吗？", "This file has unsaved changes. Discard them and open another file?"))
    ) {
      return;
    }
    if (entry.path === selectedPath && preview) return;
    setSelectedPath(entry.path);
    setPreviewLoading(true);
    try {
      const result = await window.desktop.workspace.readPreview(
        workspacePath,
        entry.path,
      );
      setPreview(result);
      setEditorContent(result.binary ? "" : result.content || "");
      setSavedContent(result.binary ? "" : result.content || "");
    } catch (error) {
      setPreview(null);
      setEditorContent("");
      setSavedContent("");
      onNotice(error?.message || tr("无法预览文件", "Unable to preview the file"));
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!initialPath || initialPath === selectedPath) return;
    let cancelled = false;
    const revealFile = async () => {
      const parts = initialPath.replace(/\\/g, "/").split("/");
      const directories = parts.slice(0, -1);
      let currentPath = "";
      for (const part of directories) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const directoryPath = currentPath;
        await loadDirectory(directoryPath);
        if (cancelled) return;
        setExpandedDirectories((current) => {
          const next = new Set(current);
          next.add(directoryPath);
          return next;
        });
      }
      if (!cancelled) {
        await openFile({
          path: initialPath,
          name: parts.at(-1),
          type: "file",
        });
      }
    };
    void revealFile();
    return () => {
      cancelled = true;
    };
  }, [initialPath, selectedPath, workspacePath]);

  useEffect(() => {
    if (!dirty) return undefined;
    const preventCloseWithUnsavedChanges = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener(
      "beforeunload",
      preventCloseWithUnsavedChanges,
    );
    return () =>
      window.removeEventListener(
        "beforeunload",
        preventCloseWithUnsavedChanges,
      );
  }, [dirty]);

  const saveFile = async () => {
    if (!editable || !dirty || saving) return;
    if (!window.desktop?.workspace?.saveText) {
      onNotice(tr("当前桌面桥不支持保存，请重启 AporiaX", "The desktop bridge cannot save files. Restart AporiaX."));
      return;
    }
    setSaving(true);
    try {
      const result = await window.desktop.workspace.saveText({
        workspacePath,
        requestedPath: preview.path,
        content: editorContent,
        expectedContent: savedContent,
      });
      setPreview((current) => ({ ...current, ...result }));
      setSavedContent(result.content);
      setEditorContent(result.content);
      onNotice(tr("已保存 {path}", "Saved {path}", { path: result.path }));
    } catch (error) {
      onNotice(error?.message || tr("保存文件失败", "Failed to save the file"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside
      className={`file-explorer-panel ${embedded ? "embedded" : ""}`}
      style={style}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void saveFile();
        }
      }}
    >
      <header>
        <div>
          <span>{tr("工作区", "Workspace")}</span>
          <strong>{tr("文件与代码", "Files and code")}</strong>
        </div>
        <div>
          <button type="button" aria-label={tr("刷新文件", "Refresh files")} onClick={loadTree}>
            <RefreshCw size={15} />
          </button>
          {!embedded && (
            <button type="button" aria-label={tr("关闭文件面板", "Close files panel")} onClick={onClose}>
              <X size={17} />
            </button>
          )}
        </div>
      </header>
      <div className="file-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("搜索已打开的文件", "Search opened files")}
          aria-label={tr("搜索已加载的工作区文件", "Search loaded workspace files")}
        />
      </div>
      <div className="file-explorer-body">
        <div className="workspace-tree">
          {loadingDirectories.has(".") && !entriesByDirectory["."] ? (
            <div className="workspace-tree-state">
              <LoaderCircle className="spin" size={15} />
              {tr("正在读取工作区", "Reading workspace")}
            </div>
          ) : filteredEntries.length ? (
            filteredEntries.map((entry) => (
              <button
                className={entry.path === selectedPath ? "active" : ""}
                key={entry.path}
                style={{ paddingLeft: `${12 + entry.depth * 13}px` }}
                type="button"
                onClick={() =>
                  entry.type === "directory"
                    ? void toggleDirectory(entry)
                    : void openFile(entry)
                }
              >
                {entry.type === "directory" ? (
                  <>
                    {loadingDirectories.has(entry.path) ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : expandedDirectories.has(entry.path) ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    {expandedDirectories.has(entry.path) ? (
                      <FolderOpen size={14} />
                    ) : (
                      <Folder size={14} />
                    )}
                  </>
                ) : (
                  <>
                    <span className="workspace-tree-indent" />
                    <FileGlyph path={entry.path} size={14} />
                  </>
                )}
                <span className="workspace-tree-name">{entry.name}</span>
                {entry.type === "file" && <ChevronRight className="workspace-tree-open-file" size={12} />}
              </button>
            ))
          ) : (
            <div className="workspace-tree-state">{tr("没有匹配的文件", "No matching files")}</div>
          )}
        </div>
        <div className="workspace-preview">
          {previewLoading ? (
            <div className="workspace-preview-empty">
              <LoaderCircle className="spin" size={17} />
              {tr("正在加载文件", "Loading file")}
            </div>
          ) : preview ? (
            <>
              <div className="workspace-preview-header">
                <FileGlyph path={preview.path} />
                <strong>{preview.path}</strong>
                {Number.isInteger(preview.pageCount) && (
                  <span>{tr("{count} 页", "{count} pages", { count: preview.pageCount })}</span>
                )}
                {preview.requiresOcr && <span>{tr("需要 OCR", "OCR required")}</span>}
                {preview.truncated && <span>{tr("已截断", "Truncated")}</span>}
                {editable && (
                  <div className="workspace-preview-actions">
                    <span className={dirty ? "dirty" : ""}>
                      {dirty ? tr("未保存", "Unsaved") : tr("已保存", "Saved")}
                    </span>
                    <button
                      type="button"
                      disabled={!dirty || saving}
                      onClick={() => void saveFile()}
                    >
                      {saving ? (
                        <LoaderCircle className="spin" size={13} />
                      ) : (
                        <Save size={13} />
                      )}
                      {tr("保存", "Save")}
                    </button>
                  </div>
                )}
              </div>
              {preview.binary ? (
                <OfficeArtifactReview
                  change={{
                    path: preview.path,
                    artifact: preview.artifact,
                  }}
                />
              ) : preview.readOnly ? (
                <pre className="workspace-readonly-preview">
                  <code>{preview.content}</code>
                </pre>
              ) : (
                <textarea
                  className="workspace-code-editor"
                  value={editorContent}
                  onChange={(event) =>
                    setEditorContent(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") return;
                    event.preventDefault();
                    const editor = event.currentTarget;
                    const start = editor.selectionStart;
                    const end = editor.selectionEnd;
                    const nextContent = `${editorContent.slice(0, start)}  ${editorContent.slice(end)}`;
                    setEditorContent(nextContent);
                    window.requestAnimationFrame(() => {
                      editor.selectionStart = start + 2;
                      editor.selectionEnd = start + 2;
                    });
                  }}
                  aria-label={tr("编辑 {path}", "Edit {path}", { path: preview.path })}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              )}
            </>
          ) : (
            <div className="workspace-preview-empty">
              {tr("选择文件以预览代码", "Choose a file to preview or edit")}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
