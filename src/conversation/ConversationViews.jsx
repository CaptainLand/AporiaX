import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "diff";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Eye,
  FileCode2,
  FileText,
  Files,
  History,
  LoaderCircle,
  Pause,
  RotateCcw,
  Search,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { ApprovalCard, DiffReviewPanel, UserAttachments } from "../agent-components";
import {
  buildWitnessRouteBlocks,
  collectTaskRouteRuns,
  getRouteToolMeta,
  summarizeRoutePrompt,
} from "../p0-model";
import { useI18n } from "../i18n";
import {
  FoldableUserPrompt,
  RunDurationChip,
} from "./RuntimeMessageUI.jsx";

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
  const progressive = selfCheck.mode === "progressive";
  const segmentCount = selfCheck.segments?.length || 0;

  return (
    <section className="self-check-card">
      <div className="self-check-heading">
        <span className="self-check-icon">
          <Check size={14} />
        </span>
        <div>
          <strong>
            {progressive
              ? tr("分段自检与最终封印已完成", "Staged review and final seal completed")
              : tr("强制自检已完成", "Mandatory self-check completed")}
          </strong>
          <span>
            {progressive
              ? tr(
                  "{segments} 个子 Agent 阶段已覆盖 {count} 个当前文件版本",
                  "{segments} subagent stage(s) cover {count} current file version(s)",
                  { segments: segmentCount, count: reviewedCount },
                )
              : tr("已复核 {count} 个文件", "Reviewed {count} file(s)", { count: reviewedCount })}
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

function buildTurnAnchorDiffRows(beforeContent, afterContent) {
  const rows = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const part of diffLines(
    String(beforeContent || ""),
    String(afterContent || ""),
  )) {
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

function TurnAnchorReview({
  message,
  isRunning,
  onClose,
  onRestore,
}) {
  const { tr } = useI18n();
  const activeChanges = (message?.changes || []).filter(
    (change) => !change.reverted,
  );
  const [selectedPath, setSelectedPath] = useState(
    activeChanges[0]?.path || "",
  );
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [conflicts, setConflicts] = useState([]);
  const selected =
    activeChanges.find((change) => change.path === selectedPath) ||
    activeChanges[0] ||
    null;
  const rows = useMemo(
    () =>
      selected && !selected.binary
        ? buildTurnAnchorDiffRows(
            selected.beforeContent,
            selected.afterContent,
          )
        : [],
    [selected],
  );
  const additions = activeChanges.reduce(
    (sum, change) => sum + (Number(change.additions) || 0),
    0,
  );
  const deletions = activeChanges.reduce(
    (sum, change) => sum + (Number(change.deletions) || 0),
    0,
  );

  const restore = async () => {
    if (!confirming) {
      setConfirming(true);
      setConflicts([]);
      return;
    }
    setRestoring(true);
    setConflicts([]);
    try {
      const result = await onRestore(message.id);
      if (result?.success) {
        onClose();
        return;
      }
      setConflicts(result?.conflicts || []);
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  };

  return createPortal(
    <div
      className="review-backdrop turn-anchor-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !restoring) onClose();
      }}
    >
      <section
        className="review-panel turn-anchor-review"
        role="dialog"
        aria-modal="true"
        aria-label={tr("回退本轮 Anchor", "Restore this turn's Anchor")}
      >
        <header className="review-panel-header">
          <div>
            <Undo2 size={17} />
            <div>
              <strong>{tr("回退这一轮", "Restore this turn")}</strong>
              <span>
                {tr(
                  "{count} 个文件 · +{additions} -{deletions} · 先预览，确认后才会执行",
                  "{count} file(s) · +{additions} -{deletions} · review before restoring",
                  {
                    count: activeChanges.length,
                    additions,
                    deletions,
                  },
                )}
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label={tr("关闭 Anchor 预览", "Close Anchor preview")}
            disabled={restoring}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="review-panel-body">
          <aside className="review-file-list">
            {activeChanges.map((change) => (
              <button
                className={change.path === selected?.path ? "active" : ""}
                key={change.path}
                type="button"
                onClick={() => setSelectedPath(change.path)}
              >
                {change.binary ? (
                  <Files size={15} />
                ) : change.path.match(/\.(js|jsx|ts|tsx|css|html|json|py|vue)$/i) ? (
                  <FileCode2 size={15} />
                ) : (
                  <FileText size={15} />
                )}
                <span>{change.path}</span>
                {change.deleted || change.afterMissing ? (
                  <em className="deleted-change-kind">
                    {tr("删除", "Deleted")}
                  </em>
                ) : change.created ? (
                  <em className="anchor-created-kind">
                    {tr("新增", "New")}
                  </em>
                ) : change.binary ? (
                  <em className="office-change-kind">
                    {change.artifact?.label || tr("二进制", "Binary")}
                  </em>
                ) : (
                  <em>
                    <b>+{change.additions || 0}</b>
                    <i>-{change.deletions || 0}</i>
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
                    {selected.binary ? (
                      <Files size={15} />
                    ) : (
                      <FileCode2 size={15} />
                    )}
                    <strong>{selected.path}</strong>
                    {selected.created && <span>{tr("新增", "New")}</span>}
                    {(selected.deleted || selected.afterMissing) && (
                      <span className="deleted">
                        {tr("已删除", "Deleted")}
                      </span>
                    )}
                  </div>
                  {!selected.binary && (
                    <span className="turn-anchor-diff-totals">
                      <b>+{selected.additions || 0}</b>
                      <i>-{selected.deletions || 0}</i>
                    </span>
                  )}
                </div>
                {selected.binary ? (
                  <div className="turn-anchor-binary-preview">
                    <Files size={28} />
                    <strong>
                      {selected.artifact?.label ||
                        tr("二进制文件检查点", "Binary file checkpoint")}
                    </strong>
                    <span>
                      {tr(
                        "二进制内容不会以文本展开；确认后会恢复该文件在本轮之前的完整版本。",
                        "Binary content is not rendered as text. Confirming restores the complete version from before this turn.",
                      )}
                    </span>
                  </div>
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
                      <div className="diff-empty">
                        {tr("文件内容没有文本差异。", "No text diff is available for this file.")}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="diff-empty">
                {tr("这一轮没有可恢复的文件。", "This turn has no restorable files.")}
              </div>
            )}
          </main>
        </div>

        <footer className="review-panel-footer turn-anchor-footer">
          <div className="turn-anchor-restore-copy">
            {conflicts.length > 0 ? (
              <span className="turn-anchor-conflict">
                <AlertTriangle size={14} />
                {tr(
                  "未执行回退：{path} 在本轮之后又发生了修改。工作区保持不变。",
                  "Restore was not applied: {path} changed after this turn. The workspace is unchanged.",
                  { path: conflicts[0]?.path || tr("某个文件", "a file") },
                )}
              </span>
            ) : confirming ? (
              <span className="turn-anchor-warning">
                <AlertTriangle size={14} />
                {tr(
                  "确定回退吗？文件将恢复到本轮之前；本轮输出会从有效对话中收起，但仍保留为审计记录。",
                  "Restore now? Files return to their pre-turn state. This output is folded out of the active dialogue but retained as an audit record.",
                )}
              </span>
            ) : (
              <span>
                {tr(
                  "Anchor 会先做完整冲突检查；任何文件不匹配时，本轮不会回退任何内容。",
                  "Anchor runs a full conflict check first. If any file no longer matches, nothing in this turn is restored.",
                )}
              </span>
            )}
          </div>
          <div>
            <button
              type="button"
              disabled={restoring}
              onClick={() => {
                if (confirming) {
                  setConfirming(false);
                  return;
                }
                onClose();
              }}
            >
              {confirming ? tr("再检查一下", "Review again") : tr("取消", "Cancel")}
            </button>
            <button
              className={confirming ? "turn-anchor-confirm" : ""}
              type="button"
              disabled={isRunning || restoring || !activeChanges.length}
              onClick={() => void restore()}
            >
              {restoring ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Undo2 size={14} />
              )}
              {isRunning
                ? tr("任务运行中", "Task is running")
                : confirming
                  ? tr("确认回退这一轮", "Confirm turn restore")
                  : tr("准备回退", "Prepare restore")}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function AssistantMessage({ message, onRetry, onOpenAnchor }) {
  const { tr } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const failed = message.error || message.status === "failed";
  const interrupted = message.status === "interrupted";
  const hasAnchor = Boolean(message.anchor && message.changes?.length);
  const restored = Boolean(message.anchorRestoredAt);

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
        <RunDurationChip message={message} />
        {hasAnchor && (
          <button
            className={`turn-anchor-button ${restored ? "restored" : ""}`}
            type="button"
            disabled={restored || message.status === "running"}
            title={
              restored
                ? tr("这一轮已经回退", "This turn has been restored")
                : tr("预览并回退这一轮", "Preview and restore this turn")
            }
            aria-label={
              restored
                ? tr("这一轮已经回退", "This turn has been restored")
                : tr("预览并回退这一轮", "Preview and restore this turn")
            }
            onClick={() => onOpenAnchor(message)}
          >
            {restored ? <Check size={13} /> : <Undo2 size={13} />}
            <span>Anchor</span>
          </button>
        )}
      </div>
      {Array.isArray(message.progressUpdates) &&
        message.progressUpdates.length > 0 && (
          <div className="assistant-progress-journal">
            {message.progressUpdates.map((update, index) => (
              <section
                className={`assistant-progress-entry ${update.kind || "progress"}`}
                key={update.id || `${message.id}-progress-${index}`}
              >
                <header>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{update.title}</strong>
                </header>
                {update.kind === "plan" ? (
                  <div className="assistant-progress-plan">
                    {update.explanation && <p>{update.explanation}</p>}
                    <ol>
                      {(update.steps || []).map((step) => (
                        <li className={step.status} key={step.id || step.title}>
                          {step.title}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <MarkdownMessage content={update.content || ""} />
                )}
              </section>
            ))}
          </div>
        )}
      <div className="assistant-message-content">
        {restored ? (
          <div className="restored-turn-output">
            <div>
              <Check size={14} />
              <span>
                {tr(
                  "这一轮的文件改动和有效输出已回退",
                  "This turn's file changes and active output were restored",
                )}
              </span>
            </div>
            {message.content && (
              <details>
                <summary>{tr("查看原始输出", "View original output")}</summary>
                <MarkdownMessage content={message.content} />
              </details>
            )}
          </div>
        ) : message.content ? (
          failed ? (
            message.content
          ) : (
            <MarkdownMessage content={message.content} />
          )
        ) : message.status === "running" ? null : (
          <span className="stream-placeholder">{tr("暂无回复内容", "No response content")}</span>
        )}
      </div>
      {(failed || interrupted) && message.prompt && (
        <button
          className="retry-message-button"
          type="button"
          disabled={retrying}
          onClick={async () => {
            if (retrying) return;
            setRetrying(true);
            try {
              await onRetry(message);
            } catch (error) {
              // retryMessage normally converts failures into visible notices.
              // Keep an observable fallback instead of silently discarding an
              // unexpected render-layer exception.
              console.error("AporiaX retry action failed", error);
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <RotateCcw size={13} />
          )}
          {retrying
            ? tr("正在重试", "Retrying")
            : message.recoverable
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

function formatWitnessElapsed(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function describeWitnessRecord(record, tr, language) {
  if (!record) {
    return {
      title: tr("正在理解任务", "Understanding the task"),
      detail: tr("等待第一个可观察动作", "Waiting for the first observable action"),
    };
  }
  if (record.kind === "tool") {
    const meta = getRouteToolMeta(record.tool, "work", language);
    const actor =
      record.actor === "subagent"
        ? record.role === "review"
          ? tr("审查 Agent", "Review agent")
          : record.role === "verify"
            ? tr("验证 Agent", "Verify agent")
            : tr("探索 Agent", "Explore agent")
        : tr("主 Agent", "Main agent");
    return {
      title: `${actor} · ${meta.title}`,
      detail: record.path || record.command || record.detail || "",
    };
  }
  const descriptions = {
    "turn.started": [tr("Witness 开始记录", "Witness started recording"), tr("正在建立任务进度账本", "Creating the task progress ledger")],
    "response.reset": [tr("主 Agent 正在思考", "Main agent is thinking"), tr("正在整理证据并决定下一步", "Reviewing evidence and deciding the next step")],
    "plan.updated": [tr("行动路径已更新", "Action route updated"), record.detail],
    "parallel_batch.started": [tr("正在并行处理独立工作", "Running independent work in parallel"), tr("并发执行 {count} 个动作", "Running {count} actions concurrently", { count: record.detail || 0 })],
    "subagent.started": [tr("子 Agent 已开始工作", "Subagent started working"), record.detail],
    "subagent.completed": [tr("子 Agent 已返回记录", "Subagent returned its record"), record.detail],
    "subagent.failed": [tr("子 Agent 未能完成", "Subagent did not complete"), record.detail],
    "self_check.started": [tr("进入强制自检", "Mandatory self-check started"), tr("正在复核修改和验证结果", "Reviewing changes and verification evidence")],
    "self_check.segment.started": [tr("分段子 Agent 自检", "Staged subagent review"), tr("正在复核 {count} 个当前文件版本", "Reviewing {count} current file version(s)", { count: record.detail || 0 })],
    "self_check.segment.completed": [tr("分段自检已记录", "Staged review recorded"), record.detail],
    "self_check.fallback": [tr("切换到完整自检", "Switching to full self-check"), tr("分段证据不完整，启用安全兜底", "Staged evidence was incomplete; safety fallback enabled")],
    "self_check.sealed": [tr("最终证据已封印", "Final evidence sealed"), tr("当前文件版本均已有匹配的审查依据", "Every current file version has matching review evidence")],
    "self_check.completed": [tr("强制自检完成", "Mandatory self-check completed"), tr("正在整理最终结果", "Preparing the final result")],
    "instructions.loaded": [tr("已加载目录规则", "Scoped project rules loaded"), record.detail],
    "context.compacted": [tr("已整理长任务上下文", "Long-task context compacted"), tr("关键约束与证据已保留", "Key constraints and evidence were preserved")],
    "memory.updated": [tr("项目记忆已更新", "Project memory updated"), record.detail],
    "approval.required": [tr("等待用户确认", "Waiting for approval"), record.command],
    "control.paused": [tr("任务已暂停", "Task paused"), tr("Witness 将继续保留当前进度", "Witness will preserve the current progress")],
    "control.resumed": [tr("任务继续运行", "Task resumed"), tr("从安全边界继续执行", "Continuing from the safe boundary")],
    "turn.completed": [tr("任务执行完成", "Task execution completed"), tr("Witness 已保存本轮行动记录", "Witness saved the action record")],
    "turn.cancelled": [tr("任务已停止", "Task stopped"), tr("已保留停止前的行动记录", "The action record before interruption was preserved")],
    "turn.failed": [tr("任务运行失败", "Task run failed"), record.detail],
  };
  const [title, detail] = descriptions[record.eventType] ||
    (record.kind === "warning"
      ? [tr("Witness 发现需要注意的情况", "Witness detected an issue"), record.detail]
      : [tr("任务状态已更新", "Task status updated"), record.detail]);
  return { title, detail: detail || "" };
}

function WitnessPanel({ witness, liveProgress }) {
  const { tr, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const records = witness?.records || [];
  const visibleRecords = expanded ? records : records.slice(-3);
  const currentDescription = describeWitnessRecord(
    witness?.current,
    tr,
    language,
  );
  const activeAgents = witness?.counters?.activeAgents || 0;
  const alerts = witness?.alerts || [];
  const witnessFinished = ["completed", "failed", "interrupted"].includes(
    witness?.status,
  );
  const witnessStateLabel =
    witness?.status === "completed"
      ? tr("已完成", "Done")
      : witness?.status === "failed"
        ? tr("失败", "Failed")
        : witness?.status === "interrupted"
          ? tr("已停止", "Stopped")
          : witness?.current?.longRunning
            ? tr("耗时较长", "Long running")
            : tr("正在做", "Now");

  useEffect(() => {
    setExpanded(false);
  }, [witness?.startedAt]);

  return (
    <section className="witness-panel" aria-label={tr("Witness 任务监控", "Witness task monitor")}>
      <header className="witness-heading">
        <span className="witness-mark">
          <Eye size={15} />
        </span>
        <div>
          <strong>Witness</strong>
          <span>
            {witnessFinished
              ? tr(
                  "本轮行动记录已保留，可随时展开回看",
                  "This run's action record is retained and available below",
                )
              : activeAgents
              ? tr("正在监控主 Agent 与 {count} 个子 Agent", "Monitoring the main agent and {count} subagent(s)", { count: activeAgents })
              : tr("正在记录主 Agent 的可观察行动", "Recording the main agent's observable actions")}
          </span>
        </div>
        <b>
          {witness?.status === "completed"
            ? 100
            : liveProgress.progress}%
        </b>
      </header>

      <div className="harness-progress-track" aria-hidden="true">
        <span
          style={{
            width: `${witness?.status === "completed" ? 100 : liveProgress.progress}%`,
          }}
        />
      </div>

      <div className="witness-current">
        <span className={witness?.current?.longRunning ? "long-running" : ""}>
          {witnessStateLabel}
        </span>
        <div>
          <strong>
            {currentDescription.title ||
              liveProgress.currentEntry?.title}
          </strong>
          <p>
            {currentDescription.detail ||
              liveProgress.currentEntry?.path ||
              liveProgress.currentEntry?.detail}
          </p>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="witness-alert">
          <AlertTriangle size={13} />
          <span>{alerts.at(-1).detail}</span>
        </div>
      )}

      {visibleRecords.length > 0 && (
        <div className="witness-ledger">
          {visibleRecords.map((record) => {
            const description = describeWitnessRecord(record, tr, language);
            return (
              <div className={`witness-record ${record.status}`} key={record.id}>
                <span className="witness-record-state">
                  {record.status === "running" || record.status === "waiting" ? (
                    <LoaderCircle className="spin" size={12} />
                  ) : record.status === "failed" ? (
                    <AlertTriangle size={12} />
                  ) : (
                    <Check size={12} />
                  )}
                </span>
                <div>
                  <strong>{description.title}</strong>
                  {description.detail && <span>{description.detail}</span>}
                </div>
                <time>{formatWitnessElapsed(record.elapsedMs)}</time>
              </div>
            );
          })}
        </div>
      )}

      {records.length > 3 && (
        <button
          className="witness-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? tr("收起记录", "Collapse records")
            : tr("查看全部 {count} 条记录", "View all {count} records", { count: records.length })}
          <ChevronDown size={13} />
        </button>
      )}
    </section>
  );
}

export function Conversation({
  task,
  isRunning,
  approval,
  approvalResponding,
  onRespondApproval,
  onRetry,
  onRevert,
  onRestoreTurnAnchor,
  onConfirmChanges,
  onSaveChanges,
  onNotice,
}) {
  const { tr } = useI18n();
  const [reviewRequest, setReviewRequest] = useState(null);
  const [anchorRequest, setAnchorRequest] = useState(null);
  const [reverting, setReverting] = useState(false);
  const reviewMessage = task.messages.find(
    (message) => message.id === reviewRequest?.messageId,
  );
  const anchorMessage = task.messages.find(
    (message) => message.id === anchorRequest?.messageId,
  );
  const activeRunMessage = [...task.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.status === "running",
    );
  const witnessMessage =
    activeRunMessage ||
    [...task.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && Boolean(message.witness),
      );
  const liveProgress = getLiveRunProgress(witnessMessage);

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
              <FoldableUserPrompt content={message.content} />
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

        if (message.supersededByRetryId) return null;

        const files = collectEditedFiles(
          message.steps,
          message.content,
          message.changes,
        );
        const restored = Boolean(message.anchorRestoredAt);
        return (
          <React.Fragment key={message.id}>
            <AssistantMessage
              message={message}
              onRetry={onRetry}
              onOpenAnchor={(anchorTarget) =>
                setAnchorRequest({ messageId: anchorTarget.id })
              }
            />
            {!restored && files.length > 0 && (
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
            {!restored && <SelfCheckCard selfCheck={message.selfCheck} />}
          </React.Fragment>
        );
      })}
      <ApprovalCard
        approval={approval}
        responding={approvalResponding}
        onRespond={onRespondApproval}
      />
      {(isRunning || witnessMessage?.witness) && (
        <WitnessPanel
          witness={witnessMessage?.witness}
          liveProgress={liveProgress}
        />
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
      {anchorMessage?.anchor && anchorMessage?.changes?.length > 0 && (
        <TurnAnchorReview
          message={anchorMessage}
          isRunning={isRunning}
          onClose={() => setAnchorRequest(null)}
          onRestore={onRestoreTurnAnchor}
        />
      )}
    </div>
  );
}

export function RouteView({
  task,
  isRunning,
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
  const routeBlocks = buildWitnessRouteBlocks(selectedRun, language);
  const completedCount = routeBlocks.filter(
    (block) => block.status === "completed",
  ).length;
  const totalCount = routeBlocks.length;
  const selectedRunIndex = Math.max(
    0,
    runs.findIndex((run) => run.id === selectedRun?.id),
  );
  const reviewRun = runs.find((run) => run.id === review?.runId);
  const reviewChanges = (reviewRun?.changes || []).filter(
    (change) => !review?.paths?.length || review.paths.includes(change.path),
  );
  const witnessDescription = describeWitnessRecord(
    selectedRun?.witness?.current,
    tr,
    language,
  );

  const blockIcon = (block) => {
    if (block.status === "running") {
      return <LoaderCircle className="spin" size={18} />;
    }
    if (block.status === "attention" || block.status === "interrupted") {
      return <AlertTriangle size={18} />;
    }
    if (block.kind === "understand") return <Brain size={18} />;
    if (block.kind === "explore") return <Search size={18} />;
    if (block.kind === "plan") return <History size={18} />;
    if (block.kind === "execute") return <Files size={18} />;
    if (block.kind === "verify") return <ShieldCheck size={18} />;
    if (block.kind === "coordinate") return <Pause size={18} />;
    return <Check size={18} />;
  };

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
                      {tr("第 {count} 轮", "Run {count}", { count: index + 1 })} ·{" "}
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
                  : tr("{done}/{total} 个阶段完成", "{done}/{total} sections complete", {
                    done: completedCount,
                    total: totalCount,
                  })}
            </div>
          </div>
        </header>

        {selectedRun?.status === "running" && selectedRun?.witness && (
          <div className="route-live-status">
            <Eye size={15} />
            <div>
              <strong>{witnessDescription.title}</strong>
              <span>{witnessDescription.detail}</span>
            </div>
            <em>
              {tr(
                "Witness 已保留 {count} 条记录",
                "Witness retained {count} records",
                { count: selectedRun.witness.records?.length || 0 },
              )}
            </em>
          </div>
        )}

        <div className="route-block-list">
          {routeBlocks.map((block) => {
            const statusText =
              block.status === "running"
                ? tr("正在进行", "In progress")
                : block.status === "attention"
                  ? tr("包含需注意项", "Needs attention")
                  : block.status === "interrupted"
                    ? tr("已停止", "Stopped")
                    : tr("已完成", "Complete");
            return (
              <details
                className={`route-block ${block.kind} ${block.status}`}
                key={block.id}
                defaultOpen={block.status === "running"}
              >
                <summary>
                  <span className="route-block-icon">{blockIcon(block)}</span>
                  <span className="route-block-copy">
                    <b>{block.label}</b>
                    <strong>{block.title}</strong>
                    <span>{block.summary}</span>
                  </span>
                  <span className="route-block-status">{statusText}</span>
                  <ChevronDown size={16} />
                </summary>

                <div className="route-block-body">
                  {block.planSteps.length > 0 && (
                    <div className="route-block-plan">
                      {block.planSteps.map((step) => (
                        <div className={step.status || "pending"} key={step.id}>
                          <span>
                            {step.status === "completed" ? (
                              <Check size={13} />
                            ) : step.status === "in_progress" ? (
                              <LoaderCircle className="spin" size={13} />
                            ) : step.status === "blocked" ? (
                              <AlertTriangle size={13} />
                            ) : (
                              <span />
                            )}
                          </span>
                          <div>
                            <strong>{step.title}</strong>
                            {step.detail && <p>{step.detail}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {block.paths.length > 0 && (
                    <div className="route-block-section">
                      <span>{tr("涉及位置", "Files and locations")}</span>
                      <div className="route-block-paths">
                        {block.paths.map((path) => (
                          <code key={path}>{path}</code>
                        ))}
                      </div>
                    </div>
                  )}

                  {block.commands.length > 0 && (
                    <div className="route-block-section">
                      <span>{tr("执行命令", "Commands")}</span>
                      <div className="route-block-commands">
                        {block.commands.map((command) => (
                          <code key={command}>{command}</code>
                        ))}
                      </div>
                    </div>
                  )}

                  {block.changes.length > 0 && (
                    <div className="route-block-section">
                      <span>{tr("产生修改", "Changes")}</span>
                      <div className="route-block-changes">
                        {block.changes.map((change) => (
                          <button
                            type="button"
                            key={change.path}
                            onClick={() =>
                              setReview({
                                runId: selectedRun.id,
                                paths: [change.path],
                                path: change.path,
                              })
                            }
                          >
                            <code>{change.path}</code>
                            <span>
                              <b>+{change.additions || 0}</b>
                              <i>-{change.deletions || 0}</i>
                            </span>
                            <ArrowRight size={13} />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {block.records.length > 0 && (
                    <details className="route-block-records">
                      <summary>
                        <span>
                          {tr(
                            "查看 {count} 条具体行动",
                            "View {count} individual actions",
                            { count: block.records.length },
                          )}
                        </span>
                        <ChevronDown size={14} />
                      </summary>
                      <div>
                        {block.records.map((record) => {
                          const description = record.legacyEntry?.title
                            ? {
                                title: record.legacyEntry.title,
                                detail:
                                  record.path ||
                                  record.command ||
                                  record.detail ||
                                  "",
                              }
                            : describeWitnessRecord(record, tr, language);
                          return (
                            <div
                              className={`route-block-record ${record.status || "completed"}`}
                              key={record.id}
                            >
                              <span>
                                {["running", "waiting"].includes(record.status) ? (
                                  <LoaderCircle className="spin" size={12} />
                                ) : record.status === "failed" ? (
                                  <AlertTriangle size={12} />
                                ) : (
                                  <Check size={12} />
                                )}
                              </span>
                              <div>
                                <strong>{description.title}</strong>
                                {description.detail && (
                                  <code>{description.detail}</code>
                                )}
                              </div>
                              <time>{formatWitnessElapsed(record.elapsedMs)}</time>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              </details>
            );
          })}
        </div>

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

