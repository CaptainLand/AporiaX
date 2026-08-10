import React, { useEffect, useMemo, useState } from "react";
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
import "./extensions.css";

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
  const [state, setState] = useState({
    loading: true,
    capabilities: [],
    summary: { total: 0, bySource: {}, byKind: {} },
    skills: [],
    mcp: null,
    plugins: [],
    error: "",
  });

  useEffect(() => {
    let active = true;
    Promise.all([
      window.desktop?.core?.capabilities?.({}) || Promise.resolve({ capabilities: [], summary: {} }),
      window.desktop?.core?.skills?.({ workspacePath }) || Promise.resolve({ skills: [] }),
      window.desktop?.core?.mcp?.({ workspacePath }) || Promise.resolve(null),
      window.desktop?.core?.plugins?.() || Promise.resolve({ plugins: [] }),
    ])
      .then(([capabilityResult, skillResult, mcpResult, pluginResult]) => {
        if (!active) return;
        setState({
          loading: false,
          capabilities: capabilityResult?.capabilities || [],
          summary: capabilityResult?.summary || { total: 0, bySource: {}, byKind: {} },
          skills: skillResult?.skills || [],
          mcp: mcpResult,
          plugins: pluginResult?.plugins || [],
          error: "",
        });
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
  }, [workspacePath]);

  const sourceEntries = useMemo(
    () =>
      Object.entries(state.summary?.bySource || {})
        .filter(([, count]) => Number(count) > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    [state.summary],
  );
  const configuredMcp = state.mcp?.servers || [];

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

  return (
    <section className="extensions-center">
      <div className="application-settings-intro">
        <span>Extensions</span>
        <h3>{tr("一个入口，看清 AporiaX 的全部能力。", "One place for every AporiaX capability.")}</h3>
        <p>
          {tr(
            "Native、Browser、Plugin、Skill 与 MCP 现在共享同一 Capability Registry。",
            "Native, Browser, Plugin, Skill, and MCP capabilities now share one registry.",
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
              <span className={state.skills.length ? "ready" : ""}><Sparkles size={17} /></span>
              <div>
                <strong>Skills</strong>
                <p>
                  {state.skills.length
                    ? tr("当前发现 {count} 个 Skill。", "{count} Skill(s) discovered.", { count: state.skills.length })
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
                    ? tr("当前项目可使用 {count} 个已信任 MCP Server。", "{count} trusted MCP server(s) are available for this workspace.", { count: configuredMcp.length })
                    : tr("尚未配置可用的 MCP Server。", "No MCP server is configured yet.")}
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
                  <span className="extensions-state">{tr("已配置", "Configured")}</span>
                </div>
              ))}
            </div>
          )}

          <section className="preference-card extensions-detail-card">
            <div className="preference-card-heading">
              <span className={state.plugins.length ? "ready" : ""}><Puzzle size={17} /></span>
              <div>
                <strong>{tr("本地插件", "Local Plugins")}</strong>
                <p>{tr("已加载 {count} 个插件。", "{count} plugin(s) loaded.", { count: state.plugins.length })}</p>
              </div>
            </div>
            <span className="preference-status">{state.plugins.length}</span>
          </section>

          {state.error && <p className="extensions-error">{state.error}</p>}
          <p className="extensions-footnote">
            {tr(
              "MCP v1 仍以用户级配置文件作为信任边界；项目只能选择已信任的 Server，不能静默定义可执行命令。",
              "MCP v1 keeps the user-level config as its trust boundary; projects can select trusted servers but cannot silently define executable commands.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
