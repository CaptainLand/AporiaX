import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  CircleStop,
  FileText,
  LoaderCircle,
  Sparkles,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import {
  buildAgentProcessSummary,
  currentProcessSummary,
  deriveLiveAgentStatus,
} from "../agent-process-model.js";
import { formatTaskDuration } from "../runtime-ui-core.js";
import { useI18n } from "../i18n";
import "../agent-process-mentions.css";
import "../runtime-ui-enhancements.css";
import "../live-agent-status.css";
import "../prompt-folding.css";

const PROMPT_CHAR_LIMIT = 900;
const PROMPT_LINE_LIMIT = 12;
const PROMPT_HEIGHT_LIMIT = 240;

function processStepIcon(status) {
  if (status === "running") {
    return <LoaderCircle className="spin" size={13} />;
  }
  if (status === "attention" || status === "interrupted") {
    return <TriangleAlert size={13} />;
  }
  return <Check size={13} />;
}

export function RunDurationChip({ message }) {
  const { tr } = useI18n();
  const running = message?.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, message?.id]);

  const startedAt = Date.parse(
    message?.createdAt || message?.anchor?.startedAt || "",
  );
  const completedAt = Date.parse(
    message?.completedAt || message?.anchor?.completedAt || "",
  );
  if (!Number.isFinite(startedAt)) return null;
  if (!running && !Number.isFinite(completedAt)) return null;

  const end = running ? now : completedAt;
  const label = formatTaskDuration(Math.max(0, end - startedAt));
  return (
    <span
      className={`aporiax-run-duration ${running ? "running" : ""}`}
      title={tr(
        `本次任务运行时间 · ${label}`,
        `Task elapsed time · ${label}`,
      )}
    >
      {running && (
        <span className="aporiax-run-duration-dot" aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
}

function StatusIcon({ state }) {
  if (state === "running") {
    return <LoaderCircle className="spin" size={14} />;
  }
  if (state === "failed") return <TriangleAlert size={14} />;
  if (state === "interrupted") return <CircleStop size={14} />;
  return <Check size={14} />;
}

export function LiveAgentStatus({ message }) {
  const { tr, language } = useI18n();
  const status = deriveLiveAgentStatus(message, language);
  const skills = Array.isArray(message?.activatedSkills)
    ? message.activatedSkills
    : [];

  // Once a run finishes successfully the answer itself is the useful result.
  // A generic "Run completed / N observable actions" banner adds visual noise
  // and was easy to mistake for a meaningful Agent step. Failed/interrupted
  // runs remain visible because they still require user attention.
  if (status.state === "completed") return null;

  const progress = status.totalSteps
    ? `${status.completedSteps}/${status.totalSteps}`
    : "";

  return (
    <section
      className={`aporiax-live-agent-status ${status.state}`}
      aria-live={status.state === "running" ? "polite" : "off"}
    >
      <span className="aporiax-live-agent-status-icon" aria-hidden="true">
        <StatusIcon state={status.state} />
      </span>
      <div className="aporiax-live-agent-status-copy">
        <strong>{status.title}</strong>
        {status.detail && <span title={status.detail}>{status.detail}</span>}
      </div>
      <div className="aporiax-live-agent-status-meta">
        {skills.length > 0 && (
          <small
            className="skill"
            title={skills.map((skill) => skill.title || skill.name).join(", ")}
          >
            <Sparkles size={10} />
            {skills.length === 1
              ? skills[0].name
              : tr(`${skills.length} Skills`, `${skills.length} Skills`)}
          </small>
        )}
        {status.state === "running" && <em>{tr("进行中", "Live")}</em>}
        {progress && <small>{progress}</small>}
        {status.changeCount > 0 && (
          <small>
            {tr(
              `${status.changeCount} 文件`,
              `${status.changeCount} file${status.changeCount === 1 ? "" : "s"}`,
            )}
          </small>
        )}
      </div>
    </section>
  );
}

export function AgentProcessTrace({ message }) {
  const { tr, language } = useI18n();
  const steps = buildAgentProcessSummary(message, language);
  if (!steps.length) return null;
  const current = currentProcessSummary(steps);
  const running = message?.status === "running";

  return (
    <section className={`aporiax-agent-process ${running ? "running" : "done"}`}>
      <div className="aporiax-agent-process-heading">
        <span className="aporiax-agent-process-mark">
          {running ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Check size={14} />
          )}
        </span>
        <div>
          <strong>{running ? tr("当前操作", "Current work") : tr("本轮操作", "Work performed")}</strong>
          <span>
            {running
              ? current?.title || tr("正在执行", "Working")
              : tr(
                  `${steps.length} 项有实际结果的操作`,
                  `${steps.length} meaningful action${steps.length === 1 ? "" : "s"}`,
                )}
          </span>
        </div>
        {running && <em>{tr("进行中", "Live")}</em>}
      </div>
      <div className="aporiax-agent-process-steps">
        {steps.map((step) => (
          <details
            className={`aporiax-agent-process-step ${step.status}`}
            key={step.id}
            open={step.status === "running" ? true : undefined}
          >
            <summary>
              <span className="aporiax-agent-process-step-icon">
                {processStepIcon(step.status)}
              </span>
              <span className="aporiax-agent-process-step-copy">
                <strong>{step.title}</strong>
                {step.summary && <small>{step.summary}</small>}
              </span>
              <span className="aporiax-agent-process-step-state">
                {step.status === "running"
                  ? tr("正在做", "Working")
                  : step.status === "attention"
                    ? tr("需注意", "Attention")
                    : step.status === "interrupted"
                      ? tr("已停止", "Stopped")
                      : tr("完成", "Done")}
              </span>
            </summary>
            {(step.paths.length > 0 ||
              step.commands.length > 0 ||
              step.planSteps.length > 0) && (
              <div className="aporiax-agent-process-detail">
                {step.planSteps.map((planStep) => (
                  <div className="aporiax-agent-process-plan" key={planStep.id}>
                    <span>{planStep.status === "completed" ? "✓" : "·"}</span>
                    <div>
                      <strong>{planStep.title}</strong>
                      {planStep.detail && <small>{planStep.detail}</small>}
                    </div>
                  </div>
                ))}
                {step.paths.map((path) => (
                  <code key={`path-${path}`}>
                    <FileText size={11} />
                    {path}
                  </code>
                ))}
                {step.commands.map((command) => (
                  <code key={`command-${command}`}>
                    <Terminal size={11} />
                    {command}
                  </code>
                ))}
              </div>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}

export function FoldableUserPrompt({ content }) {
  const { tr } = useI18n();
  const bubbleRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [heightOverflow, setHeightOverflow] = useState(false);
  const text = String(content || "");
  const staticOverflow =
    text.length > PROMPT_CHAR_LIMIT ||
    text.split(/\r?\n/u).length > PROMPT_LINE_LIMIT;

  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node || expanded) return;
    setHeightOverflow(node.scrollHeight > PROMPT_HEIGHT_LIMIT);
  }, [text, expanded]);

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  if (!text) return null;
  const foldable = staticOverflow || heightOverflow;
  return (
    <>
      <div
        ref={bubbleRef}
        className={`message-bubble ${
          foldable && !expanded ? "native-prompt-collapsed" : ""
        }`}
      >
        {text}
      </div>
      {foldable && (
        <button
          type="button"
          className="prompt-fold-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? tr("收起提示词", "Collapse prompt")
            : tr("展开完整提示词", "Expand full prompt")}
        </button>
      )}
    </>
  );
}