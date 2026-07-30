import React, { useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
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
          ["内容块", artifact.blockCount ?? artifact.paragraphCount],
          ["段落", artifact.paragraphCount],
          ["表格", artifact.tableCount],
        ]
      : artifact.kind === "presentation"
        ? [
            ["幻灯片", artifact.slideCount],
            ["文本项", artifact.bulletCount ?? inspectedSlideRuns],
            ["布局提醒", artifact.warnings?.length || 0],
          ]
        : [
            ["工作表", artifact.sheetCount],
            ["数据行", artifact.rowCount ?? inspectedRows],
            ["公式", artifact.formulaCount],
          ];

  return (
    <div className="office-artifact-review">
      <div className="office-artifact-summary">
        <span className="office-artifact-icon">
          <FileText size={22} />
        </span>
        <div>
          <strong>{artifact.label || "Office 工件"}</strong>
          <span>
            {artifact.title || change.path} · {formatBytes(artifact.bytes)}
          </span>
        </div>
        <em>
          <Check size={13} />
          结构已生成
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
          <strong>尚未完成视觉渲染检查</strong>
          <span>
            Harness 已验证文件包可以解析；最终分页、字体、图表和版式仍建议在
            Office 中打开确认。
          </span>
        </div>
      </div>
    </div>
  );
}

export function UserAttachments({ attachments }) {
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
              <strong>{attachment.name || "未命名附件"}</strong>
              <small>
                {attachment.format || "文件"}
                {Number.isInteger(attachment.pageCount)
                  ? ` · ${attachment.pageCount} 页`
                  : ""}
                {attachment.requiresOcr ? " · 需要 OCR" : " · 已解析"}
              </small>
            </span>
          </div>
        ) : (
          <figure key={attachment.id || attachment.name}>
            <img
              src={attachment.dataUrl}
              alt={attachment.name || "图片附件"}
            />
            <figcaption>{attachment.name || "图片"}</figcaption>
          </figure>
        ),
      )}
    </div>
  );
}

export function ApprovalCard({ approval, onRespond, responding }) {
  if (!approval) return null;
  return (
    <section className="approval-card">
      <div className="approval-card-heading">
        <span>
          <Terminal size={16} />
        </span>
        <div>
          <strong>{approval.title || "需要批准"}</strong>
          <p>{approval.reason}</p>
        </div>
      </div>
      <div className="approval-command">
        <code>{approval.command}</code>
        <span>工作目录：{approval.cwd || "."}</span>
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
            ? "命令将在一次性 OS 容器中运行：默认断网、根文件系统只读，仅当前工作区可写。"
            : "OS 级沙箱不可用，AporiaX 将拒绝执行命令。"
          : "此工具将访问或修改当前工作区，请确认本次操作符合预期。"}
      </div>
      {approval.kind === "execute" && approval.sandbox?.available && (
        <div className="approval-sandbox-facts">
          <span>{approval.sandbox.backend}</span>
          <span>网络：关闭</span>
          <span>内存：{approval.sandbox.memory}</span>
          <span>进程：{approval.sandbox.pidsLimit}</span>
        </div>
      )}
      <div className="approval-actions">
        <button
          type="button"
          disabled={responding}
          onClick={() => onRespond(false)}
        >
          拒绝
        </button>
        <button
          className="approve"
          type="button"
          disabled={responding}
          onClick={() => onRespond(true)}
        >
          {responding && <LoaderCircle className="spin" size={14} />}
          本次允许
        </button>
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
}) {
  const availableChanges = changes || [];
  const [selectedPath, setSelectedPath] = useState(
    availableChanges.find((change) => !change.reverted)?.path ||
      availableChanges[0]?.path ||
      "",
  );
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

  return (
    <div
      className="review-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="review-panel" aria-label="文件变更审核">
        <header className="review-panel-header">
          <div>
            <GitCompare size={17} />
            <div>
              <strong>变更审核</strong>
              <span>{availableChanges.length} 个文件检查点</span>
            </div>
          </div>
          <button type="button" aria-label="关闭审核" onClick={onClose}>
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
                    已撤销
                  </em>
                ) : change.binary ? (
                  <em className="office-change-kind">
                    {change.artifact?.label || "Office"}
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
                    {selected.created && <span>新增</span>}
                  </div>
                  <button
                    type="button"
                    disabled={selected.reverted || reverting}
                    onClick={() => onRevert([selected.path])}
                  >
                    <Undo2 size={14} />
                    {selected.reverted ? "已撤销" : "撤销此文件"}
                  </button>
                </div>
                {selected.binary ? (
                  <OfficeArtifactReview change={selected} />
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
                      <div className="diff-empty">文件内容没有变化。</div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="diff-empty">没有可审核的文件。</div>
            )}
          </main>
        </div>

        <footer className="review-panel-footer">
          <span>撤销前会检查文件是否在此检查点后被再次修改。</span>
          <div>
            {onConfirm && (
              <button
                className="confirm-review-button"
                type="button"
                disabled={confirmed}
                onClick={onConfirm}
              >
                <Check size={14} />
                {confirmed ? "本轮修改已确认" : "确认保留本轮修改"}
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
              撤销本轮全部更改
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
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
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

  const loadTree = async () => {
    if (!workspacePath || !window.desktop?.workspace) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await window.desktop.workspace.listTree(workspacePath);
      setEntries(result.entries || []);
    } catch (error) {
      onNotice(error?.message || "无法读取工作区文件");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedPath("");
    setPreview(null);
    setEditorContent("");
    setSavedContent("");
    void loadTree();
  }, [workspacePath]);

  const filteredEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return entries;
    return entries.filter((entry) =>
      entry.path.toLowerCase().includes(keyword),
    );
  }, [entries, query]);

  const openFile = async (entry) => {
    if (entry.type !== "file") return;
    if (
      dirty &&
      entry.path !== selectedPath &&
      !window.confirm("当前文件有未保存修改。放弃修改并打开其他文件吗？")
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
      onNotice(error?.message || "无法预览文件");
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!initialPath || loading || initialPath === selectedPath) return;
    const entry = entries.find(
      (candidate) =>
        candidate.type === "file" && candidate.path === initialPath,
    );
    if (entry) void openFile(entry);
  }, [entries, initialPath, loading, selectedPath]);

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
      onNotice("当前桌面桥不支持保存，请重启 AporiaX");
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
      onNotice(`已保存 ${result.path}`);
    } catch (error) {
      onNotice(error?.message || "保存文件失败");
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
          <span>工作区</span>
          <strong>文件与代码</strong>
        </div>
        <div>
          <button type="button" aria-label="刷新文件" onClick={loadTree}>
            <RefreshCw size={15} />
          </button>
          {!embedded && (
            <button type="button" aria-label="关闭文件面板" onClick={onClose}>
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
          placeholder="搜索文件"
          aria-label="搜索工作区文件"
        />
      </div>
      <div className="file-explorer-body">
        <div className="workspace-tree">
          {loading ? (
            <div className="workspace-tree-state">
              <LoaderCircle className="spin" size={15} />
              正在读取工作区
            </div>
          ) : filteredEntries.length ? (
            filteredEntries.map((entry) => (
              <button
                className={entry.path === selectedPath ? "active" : ""}
                key={entry.path}
                style={{ paddingLeft: `${12 + entry.depth * 13}px` }}
                type="button"
                onClick={() => openFile(entry)}
              >
                {entry.type === "directory" ? (
                  <Folder size={14} />
                ) : (
                  <FileGlyph path={entry.path} size={14} />
                )}
                <span>{entry.name}</span>
                {entry.type === "file" && <ChevronRight size={12} />}
              </button>
            ))
          ) : (
            <div className="workspace-tree-state">没有匹配的文件</div>
          )}
        </div>
        <div className="workspace-preview">
          {previewLoading ? (
            <div className="workspace-preview-empty">
              <LoaderCircle className="spin" size={17} />
              正在加载文件
            </div>
          ) : preview ? (
            <>
              <div className="workspace-preview-header">
                <FileGlyph path={preview.path} />
                <strong>{preview.path}</strong>
                {Number.isInteger(preview.pageCount) && (
                  <span>{preview.pageCount} 页</span>
                )}
                {preview.requiresOcr && <span>需要 OCR</span>}
                {preview.truncated && <span>已截断</span>}
                {editable && (
                  <div className="workspace-preview-actions">
                    <span className={dirty ? "dirty" : ""}>
                      {dirty ? "未保存" : "已保存"}
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
                      保存
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
                  aria-label={`编辑 ${preview.path}`}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              )}
            </>
          ) : (
            <div className="workspace-preview-empty">
              选择文件以预览代码
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
