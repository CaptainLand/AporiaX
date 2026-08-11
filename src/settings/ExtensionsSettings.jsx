import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Blocks,
  Bot,
  Box,
  Check,
  ChevronRight,
  LoaderCircle,
  Puzzle,
  Sparkles,
} from "lucide-react";
import { useI18n } from "../i18n";
import { Switch } from "../components/Controls.jsx";
import "./extensions.css";

const MANAGED_SOURCES = ["browser", "skill", "mcp", "plugin"];

function sourceLabel(source, tr) {
  return {
    native: tr("原生工具", "Native tools"),
    browser: tr("浏览器", "Browser"),
    plugin: tr("插件", "Plugins"),
    mcp: "MCP",
    skill: "Skills",
    runtime: tr("运行时", "Runtime"),
  }[source] || source;
}

function SourceIcon({ source }) {
  if (source === "mcp") return <Box size={16} />;
  if (source === "skill") return <Sparkles size={16} />;
  if (source === "plugin") return <Puzzle size={16} />;
  if (source === "browser") return <Bot size={16} />;
  return <Blocks size={16} />;
}

export function ExtensionsSettings({ workspacePath = "", onNotice = () => {} }) {
  const { tr } = useI18n();
  const [savingSource, setSavingSource] = useState("");
  const [state, setState] = useState({
    loading: true,
    capabilities: [],
    summary: { total: 0, bySource: {}, byKind: {} },
    skills: [],
    mcp: null,
    plugins: [],
    policy: null,
    error: "",
  });

  const loadData = useCallback(async () => {
    const [capabilityResult, skillResult, mcpResult, pluginResult, policyResult] = await Promise.all([
      window.desktop?.core?.capabilities?.({ workspacePath }) || Promise.resolve({ capabilities: [], summary: {} }),
      window.desktop?.core?.skills?.({ workspacePath }) || Promise.resolve({ skills: [] }),
      window.desktop?.core?.mcp?.({ workspacePath }) || Promise.resolve(null),
      window.desktop?.core?.plugins?.() || Promise.resolve({ plugins: [] }),
      window.desktop?.core?.extensionPolicy?.({ workspacePath }) || Promise.resolve(null),
    ]);
    return {
      loading: false,
      capabilities: capabilityResult?.capabilities || [],
      summary: capabilityResult?.summary || { total: 0, bySource: {}, byKind: {} },
      skills: skillResult?.skills || [],
      mcp: mcpResult,
      plugins: pluginResult?.plugins || [],
      policy: policyResult,
      error: "",
    };
  }, [workspacePath]);

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true }));
    loadData()
      .then((next) => {
        if (active) setState(next);
      })
      .catch((error) => {
        if (!active) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: String(error?.message || error),
        }));
      });
    return () => {
      active = false;
    };
  }, [loadData]);

  const sourceEntries = useMemo(
    () =>
      Object.entries(state.summary?.bySource || {})
        .filter(([, count]) => Number(count) > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    [state.summary],
  );
  const configuredMcp = state.mcp?.allServers || state.mcp?.servers || [];

  const copyMcpPath = async () => {
    const path = state.mcp?.userConfigPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      onNotice(tr("MCP 配置路径已复制", "MCP config path copied"));
    } catch {
      onNotice(tr("无法复制 MCP 配置路径", "Unable to copy MCP config path"));
    }
  };

  const setSourceEnabled = async (source, enabled) => {
    if (!window.desktop?.core?.setExtensionPolicy) return;
    setSavingSource(source);
    try {
      await window.desktop.core.setExtensionPolicy({ source, enabled, workspacePath });
      setState(await loadData());
      onNotice(
        enabled
          ? tr("{source} 已启用", "{source} enabled", { source: sourceLabel(source, tr) })
          : tr("{source} 已停用", "{source} disabled", { source: sourceLabel(source, tr) }),
      );
    } catch (error) {
      onNotice(String(error?.message || error));
    } finally {
      setSavingSource("");
    }
  };

  return (
    <section className="extensions-center">
      <div className="application-settings-intro">
        <span>Extensions</span>
        <h3>{tr("一个入口，看清 AporiaX 的全部能力。", "One place for every AporiaX capability.")}</h3>
        <p>
          {tr(
            "启停只改变能力是否可用，不会提高任何工具权限；项目还可以进一步禁用扩展来源。",
            "Enable/disable controls availability only; it never elevates tool permission, and projects may further disable extension sources.",
          )}
        </p>
      </div>

      {state.loading ? (
        <div className="extensions-loading">
          <LoaderCircle className="spin" size={16} />
          {tr("正在读取能力目录…", "Loading capability catalog…")}
        </div>
      ) : (
        <>
          <div className="extensions-summary-grid">
            {sourceEntries.map(([source, count]) => (
              <article className="extension-summary-card" key={source}>
                <span><SourceIcon source={source} /></span>
                <div>
                  <strong>{sourceLabel(source, tr)}</strong>
                  <small>{tr("{count} 项能力", "{count} capabilities", { count })}</small>
                </div>
              </article>
            ))}
          </div>

          <section className="preference-card extensions-detail-card">
            <div className="preference-card-heading">
              <span className="ready"><Blocks size={17} /></span>
              <div>
                <strong>{tr("扩展来源策略", "Extension source policy")}</strong>
                <p>{tr("Native 核心能力始终可用；下面的开关只控制可选扩展来源。", "Native core capabilities remain available; these switches only control optional extension sources.")}</p>
              </div>
            </div>
          </section>
          <div className="extensions-item-list">
            {MANAGED_SOURCES.map((source) => {
              const userEnabled = state.policy?.sources?.[source] !== false;
              const projectDisabled = state.policy?.projectDisabled?.includes(source);
              const effective = state.policy?.effective?.[source] !== false;
              return (
                <div className="extensions-item" key={`policy:${source}`}>
                  <span><SourceIcon source={source} /></span>
                  <div>
                    <strong>{sourceLabel(source, tr)}</strong>
                    <small>
                      {projectDisabled
                        ? tr("当前项目已禁用", "Disabled by this project")
                        : effective
                          ? tr("当前可用", "Available")
                          : tr("已在用户设置中停用", "Disabled in user settings")}
                    </small>
                  </div>
                  <Switch
                    checked={userEnabled}
                    disabled={savingSource === source}
                    label={tr("切换 {source}", "Toggle {source}", { source: sourceLabel(source, tr) })}
                    onChange={(enabled) => void setSourceEnabled(source, enabled)}
                  />
                </div>
              );
            })}
          </div>

          <section className="preference-card extensions-detail-card">
            <div className="preference-card-heading">
              <span className={state.skills.length ? "ready" : ""}><Sparkles size={17} /></span>
              <div>
                <strong>Skills</strong>
                <p>
                  {state.skills.length
                    ? tr("发现 {count} 个 Skill；当前策略：{status}。", "{count} Skill(s) discovered; policy: {status}.", {
                        count: state.skills.length,
                        status: state.policy?.effective?.skill === false ? tr("停用", "disabled") : tr("启用", "enabled"),
                      })
                    : tr("当前没有发现 Skill。", "No Skills discovered yet.")}
                </p>
              </div>
            </div>
            <span className="preference-status">{state.skills.length}</span>
          </section>
          {state.skills.length > 0 && (
            <div className="extensions-item-list">
              {state.skills.slice(0, 12).map((skill) => (
                <div className="extensions-item" key={`${skill.source || "skill"}:${skill.name}`}>
                  <span><Sparkles size={14} /></span>
                  <div>
                    <strong>{skill.title || skill.name}</strong>
                    <small>{skill.name} · {skill.auto ? "Auto" : "Manual"}</small>
                  </div>
                  <Check size={13} />
                </div>
              ))}
            </div>
          )}

          <section className="preference-card extensions-detail-card">
            <div className="preference-card-heading">
              <span className={configuredMcp.length ? "ready" : ""}><Box size={17} /></span>
              <div>
                <strong>MCP Servers</strong>
                <p>
                  {configuredMcp.length
                    ? tr("已配置 {count} 个受信任 MCP Server；策略关闭时不会连接。", "{count} trusted MCP server(s) configured; disabled policy prevents connection.", { count: configuredMcp.length })
                    : tr("尚未配置 MCP Server。", "No MCP server is configured yet.")}
                </p>
              </div>
            </div>
            <button className="preference-action" type="button" onClick={() => void copyMcpPath()} disabled={!state.mcp?.userConfigPath}>
              {tr("复制配置路径", "Copy config path")}
              <ChevronRight size={14} />
            </button>
          </section>
          {configuredMcp.length > 0 && (
            <div className="extensions-item-list">
              {configuredMcp.map((server) => (
                <div className="extensions-item" key={server.id}>
                  <span><Box size={14} /></span>
                  <div>
                    <strong>{server.name || server.id}</strong>
                    <small>{server.id} · {server.transport}</small>
                  </div>
                  <span className="extensions-state">
                    {state.policy?.effective?.mcp === false ? tr("已停用", "Disabled") : tr("已配置", "Configured")}
                  </span>
                </div>
              ))}
            </div>
          )}

          <section className="preference-card extensions-detail-card">
            <div className="preference-card-heading">
              <span className={state.plugins.length ? "ready" : ""}><Puzzle size={17} /></span>
              <div>
                <strong>{tr("本地插件", "Local Plugins")}</strong>
                <p>{tr("已加载 {count} 个插件；停用后其能力不会进入可用目录。", "{count} plugin(s) loaded; disabling removes their capabilities from availability.", { count: state.plugins.length })}</p>
              </div>
            </div>
            <span className="preference-status">{state.plugins.length}</span>
          </section>

          {state.error && <p className="extensions-error">{state.error}</p>}
          <p className="extensions-footnote">
            {tr(
              "扩展开关不是权限开关。重新启用 Browser/MCP/Plugin 也不会绕过 Harness Permission、Approval 或 MCP 用户级信任边界。项目配置只能进一步禁用来源。",
              "Extension switches are not permission switches. Re-enabling Browser/MCP/Plugins never bypasses Harness Permission, Approval, or the user-level MCP trust boundary. Project policy can only further disable sources.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
