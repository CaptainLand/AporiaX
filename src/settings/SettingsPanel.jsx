import React from "react";
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
  const provider =
    providers.find((candidate) => candidate.id === task.providerId) ||
    providers[0];
  const executionMode = ["direct", "safe", "isolated"].includes(task.executionMode)
    ? task.executionMode
    : "safe";
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
            ? tr("直接在真实工作区执行，速度最快；智能 Permission 会拦截未知或高风险命令。", "Runs in the real workspace for maximum speed; smart Permission gates unknown and high-risk commands.")
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
            <span>{tr("智能审批", "Smart approval")}</span>
            <span>{tr("使用本机网络", "Host network")}</span>
            <span>{executionMode === "direct" ? tr("无隔离", "No isolation") : tr("冲突检查同步", "Conflict-checked sync")}</span>
          </div>
        )}
        <div className="sandbox-auto-approval">
          <div>
            <strong>{tr("命令自动执行", "Automatic command execution")}</strong>
            <span>
              {tr(
                "开启后，仅命中智能 Permission 低风险规则的命令自动执行；依赖安装、网络写入、破坏性操作等仍会询问或拒绝。",
                "When enabled, only commands recognized as low risk by smart Permission auto-run; dependency mutation, remote writes, destructive operations, and similar risks still ask or deny.",
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

