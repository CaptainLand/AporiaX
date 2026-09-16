import React, { useState } from "react";
import { taskApprovalMode } from "../state/approval-mode.js";
import { taskExecutionMode } from "../state/execution-mode.js";
import {
  AlertTriangle,
  Folder,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  PanelRightClose,
} from "lucide-react";
import { LanguageSwitch, useI18n } from "../i18n";
import { IconButton, SegmentedControl, Switch } from "../components/Controls.jsx";
import { TaskCapabilityCards } from "./TaskCapabilityCards.jsx";

export function SettingsPanel({
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
  const [recoveryError, setRecoveryError] = useState("");
  const provider =
    providers.find((candidate) => candidate.id === task.providerId) ||
    providers[0];
  const cloudProvider = provider?.source === "aporia-cloud" || provider?.kind === "aporia-cloud";
  const executionMode = taskExecutionMode(task.executionMode);
  const approvalMode = taskApprovalMode(task.approvalMode);
  const approvalLabel = approvalMode === "full-auto"
    ? tr("全自动审批", "Full auto approval")
    : approvalMode === "manual" ? tr("手动审批", "Manual approval") : tr("智能审批", "Smart approval");
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
                {cloudProvider
                  ? tr(
                      "Aporia Account · 使用每周额度 · 无需 API Key",
                      "Aporia Account · Weekly quota · No API key required",
                    )
                  : provider?.source === "local"
                    ? tr("本地 Endpoint · 不消耗 Aporia Cloud 额度", "Local endpoint · Does not use Aporia Cloud quota")
                    : provider?.baseUrl ||
                      tr("支持多个 OpenAI-compatible Provider", "Supports multiple OpenAI-compatible providers")}
              </span>
            </div>
          </div>
          {!provider?.managed && (
            <button className="settings-link" onClick={onManageProviders}>
              {provider ? tr("管理", "Manage") : tr("添加", "Add")}
            </button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-label">{tr("执行模式", "Execution mode")}</div>
        <SegmentedControl
          value={executionMode}
          ariaLabel={tr("命令执行模式", "Command execution mode")}
          options={[
            { value: "direct", label: tr("直接", "Direct") },
            { value: "safe", label: tr("安全", "Safe") },
            { value: "isolated", label: tr("隔离", "Isolated") },
          ]}
          onChange={(nextMode) => onUpdateTask({ executionMode: nextMode })}
        />
        <p className="settings-language-note">
          {executionMode === "direct"
            ? tr("直接在真实工作区执行，不创建临时副本；是否询问由下方审批模式决定。", "Runs in the real workspace without a temporary copy; approval behavior is controlled below.")
            : executionMode === "safe"
              ? tr("在临时工作区副本执行并冲突检查后同步；仍使用本机网络与进程权限。", "Runs in a temporary workspace copy and conflict-checks synchronization; host network and process authority remain available.")
              : tr("只在 Docker 强隔离环境执行；Docker 未就绪时不会静默降级到 Host。", "Runs only inside the Docker isolation profile; it never silently falls back to Host when Docker is unavailable.")}
        </p>
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
                ? tr("正在检测执行环境", "Checking execution environment")
                : executionMode === "direct"
                  ? tr("Direct · 真实工作区", "Direct · real workspace")
                  : executionMode === "safe"
                    ? tr("Safe · 临时工作区副本", "Safe · temporary workspace copy")
                    : sandboxStatus.available
                      ? tr("Isolated · Docker 已就绪", "Isolated · Docker ready")
                      : tr("Isolated · Docker 尚未就绪", "Isolated · Docker not ready")}
            </strong>
            <span>
              {executionMode === "direct"
                ? tr("命令直接使用 Host 工作区；敏感环境变量仍会过滤。", "Commands use the Host workspace directly; sensitive environment variables are still filtered.")
                : executionMode === "safe"
                  ? tr("命令在临时副本执行，结束后进行 Hash 冲突检查与同步。", "Commands run in a temporary copy, followed by hash-based conflict checks and synchronization.")
                  : sandboxStatus?.detail ||
                    tr("正在检测 Docker 与 AporiaX 沙箱镜像", "Checking Docker and the AporiaX sandbox image")}
            </span>
          </div>
        </div>
        {executionMode === "isolated" && !sandboxStatus?.available && (
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
        {executionMode === "isolated" && sandboxStatus?.available && (
          <div className="sandbox-constraints">
            <span>{tr("断网", "Offline")}</span>
            <span>{tr("只读系统", "Read-only system")}</span>
            <span>{sandboxStatus.memory || "1536m"}</span>
            <span>{tr("{count} 进程", "{count} processes", { count: sandboxStatus.pidsLimit || 256 })}</span>
          </div>
        )}
        {sandboxStatus && executionMode !== "isolated" && (
          <div className="sandbox-constraints fallback">
            <span>{executionMode === "direct" ? tr("真实工作区", "Real workspace") : tr("临时工作区", "Temporary workspace")}</span>
            <span>{approvalLabel}</span>
            <span>{tr("使用本机网络", "Host network")}</span>
            <span>{executionMode === "direct" ? tr("无隔离", "No isolation") : tr("冲突检查同步", "Conflict-checked sync")}</span>
          </div>
        )}
        <button type="button" className="secondary-button" onClick={async () => {
          setRecoveryError("");
          try {
            if (!window.desktop?.sandbox?.openRecovery) throw new Error(tr("请使用更新后的桌面端。", "Use the updated desktop app."));
            await window.desktop.sandbox.openRecovery();
          } catch (error) { setRecoveryError(error.message); }
        }}><FolderOpen size={15} />{tr("沙箱恢复目录", "Sandbox recovery folders")}</button>
        {recoveryError && <p role="alert">{recoveryError}</p>}
        <p className="approval-mode-description">{tr("安全模式的冲突、中断与失败产物会保留在此；重启后仍可查看。依赖使用独立副本，不回写原 node_modules。仅清理已不需要且没有运行中的记录。", "Safe-mode conflicted, interrupted or failed output remains here after restart. Dependencies use private copies, never written back to node_modules. Only clean inactive records you no longer need.")}</p>
        <div className="sandbox-auto-approval">
          <strong>{tr("审批模式", "Approval mode")}</strong>
          <SegmentedControl
            value={approvalMode}
            ariaLabel={tr("审批模式", "Approval mode")}
            options={[
              { value: "full-auto", label: tr("全自动", "Full auto") },
              { value: "smart-auto", label: tr("智能", "Smart") },
              { value: "manual", label: tr("手动", "Manual") },
            ]}
            onChange={(approvalMode) => onUpdateTask({ approvalMode })}
          />
          <span className="approval-mode-description">
            {approvalMode === "full-auto"
              ? tr("全自动 · 高权限，无需首次批准。命令、脚本、文件读取及外部操作直接执行。", "Full auto · High privilege, without first-use approval. Commands, scripts, file reads and external actions run directly.")
              : approvalMode === "smart-auto"
                ? tr("智能 · 自动放行已识别的低风险操作，其他操作请求确认。", "Smart · Automatically approves recognized low-risk actions; other actions ask for confirmation.")
                : tr("手动 · 需要审批的操作逐次请求确认。", "Manual · Actions requiring approval ask for confirmation each time.")}
          </span>
          <details className="approval-mode-details">
            <summary>{tr("权限边界与风险", "Permission boundaries and risks")}</summary>
            <p>{tr(
              "越界/不明删除、异常恢复仍确认；明确拒绝的工具不放行。不是系统隔离，无法保证拦截脚本或 MCP 的间接删除。",
              "External/ambiguous deletion and uncertain recovery still ask; denied tools stay denied. This is not OS isolation and cannot guarantee blocking indirect script/MCP deletion.",
            )}</p>
          </details>
          <span>{tr("修改在下次运行生效。", "Changes apply to the next run.")}</span>
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

      <TaskCapabilityCards
        task={task}
        providers={providers}
        onManageProviders={onManageProviders}
      />

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
