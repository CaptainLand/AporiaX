import { TaskGoalReport } from "./TaskGoalReport.jsx";
import { ClarificationCard } from "./ClarificationCard.jsx";
import { RouteActivityView } from "./RouteActivityView.jsx";
import { activityActor, describeRouteRecord } from "./route-activity-model.js";
import React, { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { classifyLink, messageLinkUrl } from "../../electron/link-target.js";
import { useWorkbenchContext } from "../workbench/use-workbench.js";
import { useFileContextMenu } from "../workbench/use-file-context-menu.js";
import remarkGfm from "remark-gfm";
import { remarkAutolinkBoundary } from "./remark-autolink-boundary.js";
import { remarkInlineReplyToggle } from './remark-inline-reply-toggle.js';
import { diffLines } from "diff";
import { turnRestorePreview } from './turn-restore-preview.js';
import { getLiveRunProgress } from './witness-progress.js';
import { supportingReply } from '../../shared/reply-presentation.js';
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Eye,
  FileCode2,
  FileText,
  Files,
  History,
  LoaderCircle,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { ApprovalCard, DiffReviewPanel, UserAttachments } from "../agent-components";
import { useI18n } from "../i18n";
import { PreviewImage } from '../images/ImageViewer.jsx';
import { latestVisibleAssistant, isHistoricalFailure, savedOutcomeFiles, hasTaskReply } from "../state/task-outcome-view.js";
import {
  FoldableUserPrompt,
  RunDurationChip,
  ExtensionNotices,
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

const LinkWorkspace = createContext("");
const ReplyAction = createContext(null);

function MarkdownReplyToggle() {
  return useContext(ReplyAction);
}

function MessageLink({ href, children, title }) {
  const workspacePath = useContext(LinkWorkspace);
  const workbench = useWorkbenchContext();
  const { language, tr } = useI18n();
  const [error, setError] = useState("");
  const resolvedHref = href;
  const link = classifyLink(resolvedHref);
  const activate = async (event, action) => {
    if (!link || link.kind === "anchor") return;
    if (!window.desktop?.links && link.kind === "web") return;
    event.preventDefault();
    setError("");
    const target = resolvedHref;
    if (action === "open" && workbench?.openHref) {
      try {
        if (await workbench.openHref(target, { workspacePath })) return;
      } catch (failure) {
        setError(failure.message);
        return;
      }
    }
    if (!window.desktop?.links) {
      setError(tr("请在桌面端打开本地文件", "Open local files in the desktop app"));
      return;
    }
    try {
      const result = await window.desktop.links.activate({ href: target, action, workspacePath, language });
      if (!result?.ok) setError(result?.error || tr("无法打开链接", "Could not open link"));
    } catch (failure) { setError(failure.message); }
  };
  if (!link) return <span>{children}</span>;
  return <>
    <a href={resolvedHref} title={title || resolvedHref} rel="noreferrer" target={link.kind === "web" ? "_blank" : undefined}
      onClick={(event) => void activate(event, "open")}
      onContextMenu={(event) => void activate(event, "menu")}
      onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) void activate(event, "menu"); }}
    >{children}</a>
    {error && <span role="alert"> — {error}</span>}
  </>;
}

// Model/effort changes leave message text intact. Keep the parsed Markdown tree
// instead of reparsing the entire history during the slider's release frame.
const MarkdownMessage = React.memo(function MarkdownMessage({ content, trailingAction }) {
  const normalizedContent = String(content || "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(
      /!\[[^\]]*\]\((?:data:image\/svg\+xml|[^)\s]+\.svg)[^)]*\)/gi,
      "",
    );

  return (
    <ReplyAction.Provider value={trailingAction}>
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAutolinkBoundary, ...(trailingAction ? [remarkInlineReplyToggle] : [])]}
        urlTransform={(url, key) => key === "href" ? messageLinkUrl(url) : defaultUrlTransform(url)}
        components={{
          pre: MarkdownCodeBlock,
          a: MessageLink,
          img: MessageImage,
          'aporiax-reply-toggle': MarkdownReplyToggle,
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
    </ReplyAction.Provider>
  );
});

function MessageImage({ src, alt }) {
  return <PreviewImage src={src} alt={alt} />;
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
  workspacePath,
  onNotice,
}) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const workbench = useWorkbenchContext();
  const fileContextMenu = useFileContextMenu({ workspacePath, onNotice, onOpenFile: path => workbench?.openFile(path) });
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
                      "{count} 个文件快照 · 可审核撤销",
                      "{count} file snapshot(s) · reviewable and reversible",
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
            onClick={() => hasSnapshots ? onReview(file.path) : workbench?.openFile(file.path)}
            onContextMenu={event => void fileContextMenu(event, file)}
            onKeyDown={event => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) void fileContextMenu(event, file);
            }}
            title={
              hasSnapshots
                ? tr(
                    "审核并编辑 {path}",
                    "Review and edit {path}",
                    { path: file.path },
                  )
                : tr("在侧栏打开 {path}", "Open {path} in sidebar", { path: file.path })
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
            {progressive || selfCheck.mode === "agent-led"
              ? tr("独立检查已记录", "Independent checks recorded")
              : tr("检查已完成", "Self-check completed")}
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
            (selfCheck.delivery?.status || (verification.passed ? "passed" : "failed")) === "passed"
              ? "passed"
              : "not-passed"
          }`}
        >
          <strong>
            {selfCheck.delivery?.status === "passed" || (selfCheck.delivery == null && verification.passed)
              ? tr("项目验证已通过", "Project verification passed")
              : selfCheck.delivery?.status === "unavailable"
                ? tr("项目验证不可用", "Project verification unavailable")
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

function TurnAnchorReview({
  message,
  isRunning,
  onClose,
  onRestore,
}) {
  const { tr } = useI18n();
  const activeChanges = useMemo(() => (message?.changes || [])
    .filter(change => !change.reverted).map(turnRestorePreview), [message?.changes]);
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
  const rows = selected?.rows || [];
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
                  "回退将影响 {count} 个文件 · 恢复 {additions} 行，移除 {deletions} 行 · 确认后才会执行",
                  "Restore affects {count} file(s) · restore {additions} lines, remove {deletions} lines · confirm to apply",
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
                {change.deleted ? (
                  <em className="deleted-change-kind">
                    {tr("将删除", "Will delete")}
                  </em>
                ) : change.created ? (
                  <em className="anchor-created-kind">
                    {tr("将恢复", "Will restore")}
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
                    {selected.created && <span>{tr("将恢复", "Will restore")}</span>}
                    {selected.deleted && (
                      <span className="deleted">
                        {tr("将删除", "Will delete")}
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
                      {selected.deleted ? tr("回退后会删除这个文件。", "Restoring will delete this file.") : tr(
                        "回退后会恢复这个文件在本轮之前的完整版本；二进制内容不以文本展示。",
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
                        {selected.deleted ? tr("回退后会删除这个空文件。", "Restoring will delete this empty file.")
                          : selected.created ? tr("回退后会恢复这个空文件。", "Restoring will restore this empty file.")
                          : tr("文件内容没有文本差异。", "No text diff is available for this file.")}
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

function FailedRunContent({ message }) {
  const { tr } = useI18n();
  const files = savedOutcomeFiles(message);
  const recoveries = (message.sandbox?.recoveries || []).filter((item) => typeof item?.directory === "string").slice(-4);
  const protocolError = /MODEL_MESSAGE_INVALID|TOOL_RESULT_INVALID|Failed to deserialize.*messages\[|missing field [`']content/i.test(message.content || "");
  return <div className="failed-run-content">
    <p>{protocolError
      ? tr("模型请求格式异常，本轮未完成。", "The model request was malformed; this attempt did not finish.")
      : tr("本轮执行未完成。", "This attempt did not finish.")}</p>
    {files.length > 0 && <div className="saved-run-files">
      <strong>{tr("已保存的文件", "Saved files")}</strong>
      <ul>{files.map((path) => <li key={path}><MessageLink href={encodeURI(path.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F")}>{path}</MessageLink></li>)}</ul>
      <p>{tr("文件改动已保留，可先打开查看；这不代表任务已完成或验证已通过。", "Saved changes are available to open. This does not mean the task is complete or verification passed.")}</p>
    </div>}
    {recoveries.length > 0 && <div className="saved-run-files">
      <strong>{tr("沙箱产物已保留", "Sandbox output retained")}</strong>
      <ul>{recoveries.map((item, index) => <li key={item.directory}><MessageLink href={encodeURI(item.directory.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F")}>{tr("查看保留产物", "Open recovery folder")} {index + 1}</MessageLink></li>)}</ul>
      <p>{tr("尚未保证写回原工作区；请先查看恢复目录中的产物和回写记录。", "Not necessarily applied to the original workspace. Inspect retained output and the sync journal first.")}</p>
    </div>}
    {message.content && <details className="run-error-details">
      <summary>{tr("查看错误详情", "Error details")}</summary>
      <pre>{message.content}</pre>
    </details>}
  </div>;
}

function AssistantMessage({ message, onRetry, onOpenAnchor, taskRunning, progressRunning, editedFiles }) {
  const { tr } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const [progressExpanded, setProgressExpanded] = useState(progressRunning);
  // Reset only at run boundaries; streaming updates must preserve manual folding.
  useEffect(() => {
    setProgressExpanded(progressRunning);
  }, [progressRunning]);
  const failed = !hasTaskReply(message) && (message.error || message.status === "failed");
  const blocked = message.status === "blocked";
  const resultDelivered = hasTaskReply(message);
  const interrupted = message.status === "interrupted";
  const hasAnchor = Boolean(message.anchor && message.changes?.length);
  const restored = Boolean(message.anchorRestoredAt);
  const replyDetails = useMemo(() => supportingReply(message.content, message.deliveryDetails), [message.content, message.deliveryDetails]);
  const [replyExpanded, setReplyExpanded] = useState(false);
  const replyDetailsId = useId();
  const canExpand = !restored && message.status !== 'running' && Boolean(replyDetails || editedFiles);
  const replyToggle = useMemo(() => canExpand ? (
    <button type="button" className="assistant-delivery-toggle"
      aria-label={tr('展开回复', 'Expand reply')} aria-expanded={replyExpanded} aria-controls={replyDetailsId}
      title={tr('展开或收起补充内容', 'Expand or collapse supporting content')}
      onClick={() => setReplyExpanded(open => !open)}>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  ) : null, [canExpand, replyExpanded, replyDetailsId, tr]);

  return (
    <article
      className={`assistant-message ${failed ? "error" : ""} ${interrupted || (blocked && !resultDelivered) ? "interrupted" : ""}`}
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
      <ExtensionNotices message={message} />
      {Array.isArray(message.progressUpdates) &&
        message.progressUpdates.length > 0 && (
          <details className="assistant-progress-disclosure" open={progressExpanded}>
            <summary className="assistant-progress-toggle"
              aria-label={progressExpanded ? tr('收起任务进展', 'Collapse task progress') : tr('展开任务进展', 'Expand task progress')}
              aria-expanded={progressExpanded}
              title={tr('展开或收起任务进展', 'Expand or collapse task progress')}
              onClick={(event) => {
                event.preventDefault();
                setProgressExpanded(open => !open);
              }}>
              <span className="assistant-progress-line" aria-hidden="true" />
            </summary>
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
          </details>
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
                {message.deliveryDetails && <MarkdownMessage content={message.deliveryDetails} />}
              </details>
            )}
          </div>
        ) : message.content ? (
          failed ? (
            <><FailedRunContent message={message} />{replyToggle}</>
          ) : (
            <MarkdownMessage content={message.content} trailingAction={replyToggle} />
          )
        ) : message.status === "running" ? null : (
          <><span className="stream-placeholder">{tr("暂无回复内容", "No response content")}</span>{replyToggle}</>
        )}
      </div>
      {canExpand && (
        <div className="assistant-delivery-details" id={replyDetailsId} hidden={!replyExpanded}>
          <div className="assistant-message-content assistant-delivery-details-content">
            {replyDetails && <MarkdownMessage content={replyDetails} />}
            {editedFiles}
          </div>
        </div>
      )}
      {(failed || interrupted || blocked) && message.prompt && (
        <button
          className="retry-message-button"
          type="button"
          disabled={retrying || taskRunning}
          title={taskRunning ? tr("当前任务运行中，请先停止或等待完成", "Wait for the current run to finish or stop it first") : undefined}
          onClick={async () => {
            if (retrying || taskRunning) return;
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
    const description = describeRouteRecord(record, language);
    return {
      title: `${activityActor(record, language)} · ${description.title}`,
      detail: description.detail,
    };
  }
  if (record.kind === 'thinking') return describeRouteRecord(record, language);
  const descriptions = {
    "turn.started": [tr("Witness 开始记录", "Witness started recording"), tr("正在建立任务进度账本", "Creating the task progress ledger")],
    "response.reset": [tr("AporiaX 正在思考或工作中…", "AporiaX is thinking or working…"), tr("正在等待模型响应", "Waiting for model response")],
    "plan.updated": [tr("行动路径已更新", "Action route updated"), record.detail],
    "parallel_batch.started": [tr("正在并行处理独立工作", "Running independent work in parallel"), tr("并发执行 {count} 个动作", "Running {count} actions concurrently", { count: record.detail || 0 })],
    "subagent.started": [tr("子 Agent 已开始工作", "Subagent started working"), record.detail],
    "subagent.completed": [tr("子 Agent 已返回记录", "Subagent returned its record"), record.detail],
    "subagent.failed": [tr("子 Agent 未能完成", "Subagent did not complete"), record.detail],
    "self_check.started": [tr("开始独立检查", "Independent check started"), tr("正在复核修改和验证结果", "Reviewing changes and verification evidence")],
    "self_check.segment.started": [tr("分段子 Agent 自检", "Staged subagent review"), tr("正在复核 {count} 个当前文件版本", "Reviewing {count} current file version(s)", { count: record.detail || 0 })],
    "self_check.segment.completed": [tr("分段自检已记录", "Staged review recorded"), record.detail],
    "self_check.fallback": [tr("切换到完整自检", "Switching to full self-check"), tr("分段证据不完整，启用安全兜底", "Staged evidence was incomplete; safety fallback enabled")],
    "self_check.sealed": [tr("最终证据已封印", "Final evidence sealed"), tr("当前文件版本均已有匹配的审查依据", "Every current file version has matching review evidence")],
    "self_check.completed": [tr("独立检查已记录", "Independent check recorded"), tr("正在整理最终结果", "Preparing the final result")],
    "instructions.loaded": [tr("已加载目录规则", "Scoped project rules loaded"), record.detail],
    "context.compacted": [tr("已整理长任务上下文", "Long-task context compacted"), tr("关键约束与证据已保留", "Key constraints and evidence were preserved")],
    "memory.updated": [tr("项目记忆已更新", "Project memory updated"), record.detail],
    "approval.required": [tr("等待用户确认", "Waiting for approval"), record.command],
    "control.paused": [tr("任务已暂停", "Task paused"), tr("Witness 将继续保留当前进度", "Witness will preserve the current progress")],
    "control.resumed": [tr("任务继续运行", "Task resumed"), tr("从安全边界继续执行", "Continuing from the safe boundary")],
    "turn.completed": [record.status === 'completed' ? tr("任务执行完成", "Task execution completed") : tr("本轮已结束", "This run has ended"), tr("Witness 已保存本轮行动记录", "Witness saved the action record")],
    "turn.cancelled": [tr("任务已停止", "Task stopped"), tr("已保留停止前的行动记录", "The action record before interruption was preserved")],
    "turn.failed": [tr("任务运行失败", "Task run failed"), record.detail],
  };
  const [title, detail] = descriptions[record.eventType] ||
    (record.kind === "warning"
      ? [tr("Witness 发现需要注意的情况", "Witness detected an issue"), record.detail]
      : [tr("任务状态已更新", "Task status updated"), record.detail]);
  return { title, detail: detail || "" };
}

function WitnessPanel({ witness, liveProgress, resultDelivered = false }) {
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
  const witnessFinished = liveProgress.finished;
  const stateLabels = {
    completed: ['已完成', 'Done'], partial: ['部分完成', 'Partially done'],
    blocked: ['任务受阻', 'Blocked'], needs_input: ['等待补充', 'Input needed'],
    failed: ['失败', 'Failed'], interrupted: ['已停止', 'Stopped'],
    paused: ['已暂停', 'Paused'], waiting: ['等待确认', 'Awaiting approval'],
  };
  const witnessStateLabel = tr(...(stateLabels[liveProgress.status]
    || (witness?.current?.longRunning ? ['耗时较长', 'Long running'] : ['正在做', 'Now'])));
  const progressLabel = liveProgress.completed ? '100%'
    : liveProgress.plan ? tr('已完成 {done}/{total} 步', '{done}/{total} steps done', {
      done: liveProgress.completedCount, total: liveProgress.totalCount,
    }) : witnessStateLabel;
  const indeterminate = liveProgress.progress === null;

  useEffect(() => {
    setExpanded(false);
  }, [witness?.startedAt]);

  return (
    <section className="witness-panel" data-status={liveProgress.status} aria-label={tr("Witness 任务监控", "Witness task monitor")}>
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
              ? tr("正在记录 AporiaX 与 {count} 个子 Agent 的行动", "Recording AporiaX and {count} subagent(s)", { count: activeAgents })
              : tr("正在记录 AporiaX 的行动", "Recording AporiaX activity")}
          </span>
        </div>
        <b>{progressLabel}</b>
      </header>

      <div className={`harness-progress-track${indeterminate ? ' witness-progress-unknown' : ''}${liveProgress.active ? ' is-active' : ''}`}
        role="progressbar" aria-label={tr('本轮任务进度', 'Task progress')}
        aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : liveProgress.progress}
        aria-valuetext={`${witnessStateLabel} · ${progressLabel}`}>
        <span
          style={{
            width: indeterminate ? undefined : `${liveProgress.progress}%`,
          }}
        />
      </div>

      <div className="witness-current">
        <span className={liveProgress.active && witness?.current?.longRunning ? "long-running" : ""}>
          {witnessStateLabel}
        </span>
        <div>
          <strong>
            {resultDelivered ? tr("本轮结果已输出", "Result delivered") : !liveProgress.active ? witnessStateLabel : currentDescription.title ||
              liveProgress.currentEntry?.title}
          </strong>
          <p title={currentDescription.progressHint}>
            {resultDelivered ? tr("可展开查看本轮行动记录", "Expand to view this run's action record") : currentDescription.detail ||
              liveProgress.currentEntry?.path ||
              liveProgress.currentEntry?.detail}
          </p>
        </div>
      </div>

      {visibleRecords.length > 0 && (
        <div className="witness-ledger">
          {visibleRecords.map((record) => {
            const description = describeWitnessRecord(record, tr, language);
            return (
              <div className={`witness-record ${record.status}`} key={record.id}>
                <span className="witness-record-state">
                  {record.status === "running" || record.status === "waiting" ? (
                    <LoaderCircle className={liveProgress.active ? 'spin' : ''} size={12} />
                  ) : record.status === "failed" ? (
                    <AlertTriangle size={12} />
                  ) : (
                    <Check size={12} />
                  )}
                </span>
                <div>
                  <strong>{description.title}</strong>
                  {description.detail && <span title={description.progressHint}>{description.detail}</span>}
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
  allowFileActions = true,
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
  const workbench = useWorkbenchContext();
  const [reviewRequest, setReviewRequest] = useState(null);
  const [anchorRequest, setAnchorRequest] = useState(null);
  const [reverting, setReverting] = useState(false);
  const reviewMessage = task.messages.find(
    (message) => message.id === reviewRequest?.messageId,
  );
  const anchorMessage = task.messages.find(
    (message) => message.id === anchorRequest?.messageId,
  );
  const latestAssistant = latestVisibleAssistant(task.messages);
  const witnessMessage = latestAssistant?.status === "running" || latestAssistant?.witness
    ? latestAssistant : null;
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
        if (message.kind === "anchor-restore") {
          return (
            <article className="anchor-restore-notice" key={message.id}>
              <Undo2 size={13} />
              <div>
                <strong>{tr("工作区已回退", "Workspace restored")}</strong>
                <span>
                  {tr(
                    "已告知后续模型：以当前文件为准，不要继续被回退的实现。",
                    "Later runs are told to treat current files as truth and not continue the restored work.",
                  )}
                </span>
              </div>
            </article>
          );
        }
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
                      "等待接入 · 正在调整生成或等待当前操作完成",
                      "Pending · redirecting generation or finishing the current operation",
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
        const editedFiles = !restored && !message.unapplied && files.length > 0 ? (
          <EditedFilesCard
            files={files}
            workspacePath={task.workspacePath}
            onNotice={onNotice}
            hasSnapshots={allowFileActions && Boolean(message.changes?.length)}
            confirmed={Boolean(message.reviewConfirmedAt)}
            onReview={(path) => allowFileActions ?
              setReviewRequest({
                messageId: message.id,
                path,
                mode: path ? "edit" : "diff",
              }) : workbench?.openFile(path || files[0]?.path)
            }
          />
        ) : null;
        const attempt = (
          <React.Fragment key={message.id}>
            <LinkWorkspace.Provider value={task.workspacePath || ""}>
            <AssistantMessage
              message={message}
              editedFiles={editedFiles}
              onRetry={onRetry}
              taskRunning={isRunning && latestAssistant?.status === "running"}
              progressRunning={Boolean(isRunning && message.id === latestAssistant?.id && message.status === "running")}
              onOpenAnchor={(anchorTarget) =>
                setAnchorRequest({ messageId: anchorTarget.id })
              }
            />
            </LinkWorkspace.Provider>
            {(message.clarifications || []).map(question => <ClarificationCard key={question.id} question={question} active={isRunning && message.status === "running"} onRetry={onRetry ? () => onRetry(message) : null} />)}
            {!restored && <SelfCheckCard selfCheck={message.selfCheck} />}
            {!restored && <TaskGoalReport brief={message.taskBrief} acceptance={message.acceptance} strategy={message.strategy} />}
          </React.Fragment>
        );
        return isHistoricalFailure(message, latestAssistant) ? (
          <details className="historical-run" key={message.id}>
            <summary><History size={14} /><span>{tr("历史尝试未完成 · 已继续后续轮次", "Earlier attempt unfinished · conversation continued")}</span><ChevronDown size={14} /></summary>
            {attempt}
          </details>
        ) : attempt;
      })}
      <ApprovalCard
        approval={approval}
        responding={approvalResponding}
        onRespond={onRespondApproval}
      />
      {((isRunning && latestAssistant?.status === "running") || witnessMessage?.witness) && (
        <WitnessPanel
          witness={witnessMessage?.witness}
          liveProgress={liveProgress}
          resultDelivered={hasTaskReply(witnessMessage)}
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

export function RouteView(props) {
  return <RouteActivityView {...props} />;
}
