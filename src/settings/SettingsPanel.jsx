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
import { IconButton, Switch } from "../components/Controls.jsx";
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

