import React, { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldCheck, X } from "lucide-react";
import { IconButton, Switch } from "../components/Controls.jsx";
import { useI18n } from "../i18n";
import { controlError, controlRequest } from "../control/control-api.js";
import "../control/external-control.css";

export function GlobalFilePermissionsPanel({ onClose }) {
  const { tr } = useI18n();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const mounted = useRef(false);
  const acting = useRef(false);
  const revision = useRef(0);
  closeRef.current = onClose;
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const snapshot = await controlRequest("getFileAccess");
      if (mounted.current && current === revision.current) {
        setSettings(snapshot || { enabled: false, unavailable: true });
        setError("");
      }
    } catch (failure) {
      if (mounted.current && current === revision.current) setError(controlError(failure, tr));
    }
  }, [tr]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialogRef.current?.focus();
    void refresh();
    const unsubscribe = window.desktop?.control?.subscribe?.(event => {
      if (event.type === "file-access.updated" && !acting.current) void refresh();
    });
    const keydown = event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), [tabindex="0"]') || [])].filter(element => element.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { mounted.current = false; revision.current++; unsubscribe?.(); document.removeEventListener("keydown", keydown, true); previous?.focus?.(); };
  }, [refresh]);
  const setEnabled = async enabled => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError(""); revision.current++;
    try {
      const result = await controlRequest("setFileAccess", { enabled, ...(enabled ? { riskAcknowledged: true } : {}) });
      if (mounted.current) { setSettings(result); setConfirm(false); }
    } catch (failure) { if (mounted.current) setError(controlError(failure, tr)); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  };
  const enabled = settings?.enabled === true;
  return <div className="control-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="external-control-panel global-file-permissions-panel" role="dialog" aria-modal="true" aria-labelledby="global-file-permissions-title" tabIndex={-1}>
      <header className="control-header"><div className="control-title-icon"><ShieldCheck size={23} /></div><div><h2 id="global-file-permissions-title">{tr("全局文件权限", "Global file permissions")}</h2><p>{tr("适用于所有任务，与外部连接开关无关。", "Applies to all tasks, independently of external connections.")}</p></div><IconButton label={tr("关闭全局文件权限", "Close global file permissions")} onClick={onClose}><X size={19} /></IconButton></header>
      {error && <p className="control-error control-global-error" role="alert">{error}<button type="button" className="control-button" disabled={busy} onClick={() => void refresh()}>{tr("重新读取", "Reload")}</button></p>}
      {!settings ? <div className="control-loading">{!error && <><LoaderCircle className="spin" size={21} /><p>{tr("正在读取权限设置…", "Loading permission settings…")}</p></>}</div> : <div className="control-scroll">
        <section className="control-enable"><div><h3>{tr("访问、修改和创建工作区外文件", "Access, edit and create files outside the workspace")}</h3><p>{tr("全局设置：同时影响桌面任务和外部客户端任务，默认关闭。", "Global setting for both desktop and external-client tasks. Off by default.")}</p></div>
          <Switch checked={enabled} disabled={busy || settings.unavailable} label={tr("允许访问工作区外文件", "Allow access outside the workspace")} onChange={value => { if (value) setConfirm(true); else void setEnabled(false); }} />
        </section>
        <section className="control-run-section"><h3>{tr("权限边界", "Permission boundaries")}</h3><p>{tr("开启后，模型的文件工具可以读取、修改和创建当前系统账号有权访问的外部文件。外部修改直接作用于本机，不在隔离工作区内，也不会包含在工作区交付补丁中。", "When enabled, model file tools can read, edit and create external files accessible to your OS account. External edits affect the host directly, outside the isolated workspace and its delivery patch.")}</p><p>{tr("只读任务仍不能写入；应用配置、凭据目录和控制元数据继续受保护。命令与 MCP 仍需各自授权，危险操作确认保留。这不是操作系统级沙箱。", "Read-only tasks cannot write. App settings, credential directories and control metadata remain protected. Commands and MCP retain separate authorization and dangerous actions retain approval. This is not an OS sandbox.")}</p><p>{tr("关闭后会在后续文件操作和待审批操作执行前重新校验；已经完成或正在进行的系统调用不能撤回。", "Disabling is checked before subsequent file operations and pending approvals execute; completed or in-flight OS operations cannot be undone.")}</p></section>
        {settings.error && <p className="control-error" role="alert">{settings.error}</p>}
        {settings.unavailable && <p className="control-error" role="alert">{tr("权限设置不可用，请更新并重启桌面端。", "Permission settings are unavailable. Update and restart the desktop app.")}</p>}
        {confirm && !enabled && <section className="control-approval" role="group" aria-label={tr("确认全局文件访问风险", "Confirm global file access risk")}>
          <h3>{tr("允许所有任务访问外部文件？", "Allow all tasks to access external files?")}</h3><p>{tr("仅在信任当前任务、模型及已连接客户端时开启。文件内容可能随任务发送给所选模型服务；错误操作可能破坏本机数据。不会获得系统管理员权限。", "Enable only if you trust the tasks, model and connected clients. File contents may be sent to the selected model provider, and mistaken edits may damage host data. This does not grant administrator privileges.")}</p>
          <div className="control-actions"><button type="button" className="control-button" disabled={busy} onClick={() => setConfirm(false)}>{tr("取消", "Cancel")}</button><button type="button" className="control-button control-primary" disabled={busy} onClick={() => void setEnabled(true)}>{tr("我了解风险，开启全局权限", "I understand the risk, enable globally")}</button></div>
        </section>}
      </div>}
    </section>
  </div>;
}
