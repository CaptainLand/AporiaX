import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Blocks,
  Bot,
  Box,
  Check,
  Download,
  LoaderCircle,
  PackageOpen,
  Plus,
  Puzzle,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  RotateCcw,
} from "lucide-react";
import { useI18n } from "../i18n";
import { Switch } from "../components/Controls.jsx";
import { ExtensionDiscovery } from "./ExtensionDiscovery.jsx";
import "./extensions.css";

const MANAGED_SOURCES = ["browser", "skill", "mcp", "plugin"];
const EMPTY_MCP = {
  id: "",
  name: "",
  transport: "streamable-http",
  url: "",
  command: "",
  argsText: "",
  secretsText: "{}",
  autoApproveReadOnly: false,
  enabled: false,
};

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

function SourceIcon({ source, size = 16 }) {
  if (source === "mcp" || source === "mcp-template") return <Box size={size} />;
  if (source === "skill") return <Sparkles size={size} />;
  if (source === "plugin") return <Puzzle size={size} />;
  if (source === "browser") return <Bot size={size} />;
  return <Blocks size={size} />;
}

function parseObject(text, label) {
  const value = String(text || "").trim();
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function localizedCatalogEntry(entry, isEnglish) {
  return {
    ...entry,
    displayTitle: isEnglish
      ? entry.titleEn || entry.title
      : entry.titleZh || entry.title,
    displayDescription: isEnglish
      ? entry.descriptionEn || entry.description
      : entry.descriptionZh || entry.description,
  };
}

export function ExtensionsSettings({ workspacePath = "", onNotice = () => {} }) {
  const { tr, isEnglish } = useI18n();
  const [tab, setTab] = useState("discover");
  const [query, setQuery] = useState("");
  const [savingSource, setSavingSource] = useState("");
  const [busyId, setBusyId] = useState("");
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpDraft, setMcpDraft] = useState(EMPTY_MCP);
  const [verification, setVerification] = useState({});
  const [state, setState] = useState({
    loading: true,
    capabilities: [],
    summary: { total: 0, bySource: {}, byKind: {} },
    skills: [],
    mcp: null,
    plugins: [],
    policy: null,
    library: null,
    error: "",
  });

  const loadData = useCallback(async () => {
    const [capabilities, skills, mcp, plugins, policy, library] = await Promise.all([
      window.desktop?.core?.capabilities?.({ workspacePath }) || Promise.resolve({ capabilities: [], summary: {} }),
      window.desktop?.core?.skills?.({ workspacePath }) || Promise.resolve({ skills: [] }),
      window.desktop?.core?.mcp?.({ workspacePath }) || Promise.resolve(null),
      window.desktop?.core?.plugins?.() || Promise.resolve({ plugins: [] }),
      window.desktop?.core?.extensionPolicy?.({ workspacePath }) || Promise.resolve(null),
      window.desktop?.core?.library?.({ workspacePath }) || Promise.resolve(null),
    ]);
    return {
      loading: false,
      capabilities: capabilities?.capabilities || [],
      summary: capabilities?.summary || { total: 0, bySource: {}, byKind: {} },
      skills: skills?.skills || [],
      skillDiagnostics: skills?.diagnostics || [],
      mcp,
      plugins: plugins?.plugins || [],
      policy,
      library,
      error: "",
    };
  }, [workspacePath]);

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      setState(await loadData());
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: String(error?.message || error),
      }));
    }
  }, [loadData]);

  useEffect(() => {
    let active = true;
    loadData()
      .then((next) => active && setState(next))
      .catch((error) => active && setState((current) => ({
        ...current,
        loading: false,
        error: String(error?.message || error),
      })));
    return () => { active = false; };
  }, [loadData]);

  const catalogEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const entries = (state.library?.catalog?.entries || []).map((entry) =>
      localizedCatalogEntry(entry, isEnglish),
    );
    if (!needle) return entries;
    return entries.filter((entry) =>
      [
        entry.title,
        entry.titleEn,
        entry.titleZh,
        entry.name,
        entry.description,
        entry.descriptionEn,
        entry.descriptionZh,
        ...(entry.tags || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [isEnglish, query, state.library]);
  const skillCatalogEntries = catalogEntries.filter((entry) => entry.type === "skill");
  const mcpCatalogEntries = catalogEntries.filter((entry) => entry.type !== "skill");
  const catalogSkillByName = new Map(
    skillCatalogEntries.map((entry) => [entry.name, entry]),
  );
  const installedSkillNames = new Set([...(state.library?.installed?.skillNames || []), ...state.skills.map((skill) => skill.name)]);
  const configuredMcp = state.mcp?.allServers || state.mcp?.servers || [];

  const runLibraryAction = async (id, action, successMessage) => {
    setBusyId(id);
    try {
      const result = await action();
      await refresh();
      onNotice(typeof successMessage === "function" ? successMessage(result) : successMessage);
      return true;
    } catch (error) {
      onNotice(String(error?.message || error));
      return false;
    } finally {
      setBusyId("");
    }
  };

  const setSourceEnabled = async (source, enabled) => {
    if (!window.desktop?.core?.setExtensionPolicy) return;
    setSavingSource(source);
    try {
      await window.desktop.core.setExtensionPolicy({ source, enabled, workspacePath });
      await refresh();
      onNotice(enabled
        ? tr("{source} 已启用", "{source} enabled", { source: sourceLabel(source, tr) })
        : tr("{source} 已停用", "{source} disabled", { source: sourceLabel(source, tr) }));
    } catch (error) {
      onNotice(String(error?.message || error));
    } finally {
      setSavingSource("");
    }
  };

  const configureTemplate = (entry = null) => {
    const template = entry?.template || {};
    setMcpDraft({
      ...EMPTY_MCP,
      id: template.id || "",
      name: template.name || entry?.displayTitle || "",
      transport: template.transport || "streamable-http",
      url: template.url === "https://" ? "" : template.url || "",
      command: template.command || "",
      secretsText: JSON.stringify(template.transport === "stdio" ? template.env || {} : template.headers || {}, null, 2),
      argsText: (template.args || [])
        .map((argument) => argument === "{workspace}" ? workspacePath : argument)
        .join("\n"),
    });
    setShowMcpForm(true);
  };

  const saveMcp = async (event) => {
    event.preventDefault();
    try {
      const server = {
        id: mcpDraft.id,
        name: mcpDraft.name || mcpDraft.id,
        transport: mcpDraft.transport,
        autoApproveReadOnly: mcpDraft.autoApproveReadOnly,
        enabled: mcpDraft.enabled,
        ...(mcpDraft.transport === "stdio"
          ? {
              command: mcpDraft.command,
              args: mcpDraft.argsText === "" ? [] : mcpDraft.argsText.split(/\r?\n/),
              env: parseObject(mcpDraft.secretsText, "Environment"),
            }
          : {
              url: mcpDraft.url,
              headers: parseObject(mcpDraft.secretsText, "Headers"),
            }),
      };
      const saved = await runLibraryAction(
        `mcp:${server.id}`,
        () => window.desktop.core.saveLibraryMcp({ server, createOnly: true }),
        tr("MCP 已保存。请点击探测，检查认证与工具目录。", "MCP saved. Probe it to check authentication and tools."),
      );
      if (!saved) return;
      setShowMcpForm(false);
      setMcpDraft(EMPTY_MCP);
      setTab("installed");
    } catch (error) {
      onNotice(String(error?.message || error));
    }
  };

  const importSkill = async () => {
    setBusyId("import:skill");
    try {
      const result = await window.desktop.core.importLibrarySkill();
      if (result?.canceled) return;
      await refresh();
      onNotice(tr("Skill 已导入", "Skill imported"));
    } catch (error) {
      onNotice(String(error?.message || error));
    } finally {
      setBusyId("");
    }
  };

  const importMcp = async () => {
    setBusyId("import:mcp");
    try {
      const result = await window.desktop.core.importLibraryMcp();
      if (result?.canceled) return;
      await refresh();
      onNotice(tr("已导入 {count} 个 MCP Server（默认停用）", "Imported {count} MCP server(s), disabled by default", { count: result?.imported?.length || 0 }) + (result?.errors?.length ? ` · ${result.errors.join("; ")}` : ""));
    } catch (error) {
      onNotice(String(error?.message || error));
    } finally {
      setBusyId("");
    }
  };

  return (
    <section className="extensions-center">
      <div className="application-settings-intro extensions-heading">
        <span>Extensions Library</span>
        <h3>{tr("给 AporiaX 安装新的方法，而不是新的权限。", "Install new methods for AporiaX, not new privileges.")}</h3>
        <p>{tr(
          "Skill 是可审阅的工作流说明；MCP 是需要信任的外部工具。导入不执行脚本；本地 MCP 进程不等于被操作系统沙箱隔离。",
          "Skills are reviewable workflows; MCP servers are trusted external tools. Importing runs no scripts. A local MCP process is not an OS sandbox.",
        )}</p>
      </div>

      <nav className="extensions-tabs" aria-label="Extensions library">
        {[
          ["discover", tr("发现", "Discover")],
          ["installed", tr("已安装", "Installed")],
          ["sources", tr("来源与权限", "Sources & policy")],
        ].map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {state.loading ? (
        <div className="extensions-loading"><LoaderCircle className="spin" size={16} />{tr("正在刷新扩展目录…", "Refreshing extension catalog…")}</div>
      ) : (
        <>
          {tab === "discover" && (
            <div className="extensions-library-view">
              <ExtensionDiscovery onConfigure={configureTemplate} onInstalled={async () => setState(await loadData())} />
              <div className="extensions-import-actions">
                <div>
                  <strong>{tr("从本机导入", "Import from this computer")}</strong>
                  <small>{tr("选择包含 SKILL.md 的文件夹，或常见格式的 MCP JSON 配置。", "Choose a folder containing SKILL.md, or an MCP JSON configuration in a common format.")}</small>
                </div>
                <span>
                  <button type="button" disabled={busyId === "import:skill"} onClick={() => void importSkill()}>
                    {busyId === "import:skill" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                    {tr("导入 Skill 文件夹", "Import Skill folder")}
                  </button>
                  <button type="button" disabled={busyId === "import:mcp"} onClick={() => void importMcp()}>
                    {busyId === "import:mcp" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                    {tr("导入 MCP JSON", "Import MCP JSON")}
                  </button>
                </span>
              </div>
              <label className="extensions-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("筛选下方精选适配", "Filter curated adapters below")} /></label>
              <div className="extensions-library-section">
                <div className="extensions-library-section-heading">
                  <div><Sparkles size={16} /><strong>{tr("精选 Skills 适配", "Curated Skill adapters")}</strong></div>
                  <p>{tr("为 Agent 增加可审阅、可复用的专业工作方法，不会自行获得新权限。", "Reviewable, reusable methods that guide the Agent without granting new permissions.")}</p>
                </div>
                <div className="extensions-catalog-grid">
                  {skillCatalogEntries.map((entry) => {
                    const installed = installedSkillNames.has(entry.name);
                    return (
                      <article className="extension-catalog-card" key={entry.id}>
                        <div className="extension-catalog-icon"><SourceIcon source="skill" size={18} /></div>
                        <div className="extension-catalog-copy">
                          <div><strong>{entry.displayTitle}</strong><span>Skill</span></div>
                          <p>{entry.displayDescription}</p>
                          <small>{entry.author} · {entry.version} · {entry.license || entry.trust}</small>
                          {!!entry.requirements?.length && <small>{entry.requirements.join(" · ")}</small>}
                        </div>
                        <button type="button" className="extension-primary-action" disabled={installed || busyId === entry.id} onClick={() => void runLibraryAction(entry.id, () => window.desktop.core.installLibrarySkill({ catalogId: entry.id }), tr("Skill 已安装", "Skill installed"))}>
                          {busyId === entry.id ? <LoaderCircle className="spin" size={14} /> : installed ? <Check size={14} /> : <Download size={14} />}
                          {installed ? tr("已安装", "Installed") : tr("安装", "Install")}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </div>
              <div className="extensions-library-section">
                <div className="extensions-library-section-heading">
                  <div><Box size={16} /><strong>{tr("MCP 工具服务", "MCP servers")}</strong></div>
                  <p>{tr("配置不等于可用。先探测工具目录，再为后续任务启用；工具调用仍遵循任务审批策略。", "Configuration is not readiness. Probe the catalog before enabling a server for future tasks; tool calls still follow task approval policy.")}</p>
                </div>
                <div className="extensions-catalog-grid">
                  {mcpCatalogEntries.map((entry) => (
                    <article className="extension-catalog-card" key={entry.id}>
                      <div className="extension-catalog-icon"><SourceIcon source={entry.type} size={18} /></div>
                      <div className="extension-catalog-copy">
                        <div><strong>{entry.displayTitle}</strong><span>MCP</span></div>
                        <p>{entry.displayDescription}</p>
                        <small>{entry.author} · {entry.version} · {entry.license || entry.trust}</small>
                        {!!entry.requirements?.length && <small>{entry.requirements.join(" · ")}</small>}
                      </div>
                      <button type="button" className="extension-primary-action" onClick={() => configureTemplate(entry)}><Plus size={14} />{tr("配置", "Configure")}</button>
                    </article>
                  ))}
                </div>
              </div>
              <button className="extensions-add-mcp" type="button" onClick={() => configureTemplate()}><Plus size={15} />{tr("添加自定义 MCP Server", "Add a custom MCP server")}</button>
            </div>
          )}

          {tab === "installed" && (
            <div className="extensions-installed-view">
              <div className="extensions-section-title"><div><Sparkles size={16} /><strong>Skills</strong></div><button type="button" disabled={busyId === "import:skill"} onClick={() => void importSkill()}><Upload size={14} />{tr("导入", "Import")}</button></div>
              <div className="extensions-item-list">
                {state.skills.length ? state.skills.map((skill) => {
                  const catalogSkill = catalogSkillByName.get(skill.name);
                  return (
                    <div className="extensions-item" key={`${skill.source}:${skill.name}`}>
                      <span><Sparkles size={14} /></span><div><strong>{catalogSkill?.displayTitle || skill.title || skill.name}</strong><small>{catalogSkill?.displayDescription || `${skill.name} · ${skill.source} · ${skill.auto ? "Auto" : "Manual"}`}</small>{skill.compatibility && <small title={skill.compatibility}>{skill.compatibility}</small>}{!!skill.compatibilityWarnings?.length && <small title={skill.compatibilityWarnings.join("; ")}>{skill.compatibilityWarnings.join("; ")}</small>}</div>
                      <span className="extensions-row-actions" title={skill.runtime?.executable || ""}>
                      {skill.source === "user" && <button className="extension-icon-action extension-text-action" type="button" disabled={!!busyId} onClick={() => void runLibraryAction(`verify:${skill.name}`, async () => { const r = await window.desktop.core.verifyLibrarySkill({ name: skill.name }); setVerification((v) => ({ ...v, [`skill:${skill.name}`]: `${tr("结构与文件校验通过；未执行脚本或验证依赖", "Files verified; scripts and dependencies not tested")} · ${new Date(r.checkedAt).toLocaleString()}` })); return r; }, tr("Skill 文件完整性验证通过；外部依赖未验证。", "Skill integrity verified; dependencies not tested."))}><ShieldCheck size={14} />{tr("验证", "Verify")}</button>}
                      {skill.source === "user" && state.library?.installed?.skillPackages?.some((item) => item.name === skill.name && item.canRollback) && <button className="extension-icon-action" type="button" disabled={!!busyId} title={tr("回退到上一版", "Roll back to previous version")} onClick={() => void runLibraryAction(`skill:${skill.name}`, () => window.desktop.core.rollbackLibrarySkill({ name: skill.name }), tr("Skill 已回退，后续任务生效", "Skill rolled back for future tasks"))}><RotateCcw size={14} /></button>}
                      {skill.source === "user" ? <button className="extension-icon-action danger" type="button" disabled={!!busyId} title={tr("卸载", "Uninstall")} onClick={() => void runLibraryAction(`skill:${skill.name}`, () => window.desktop.core.removeLibrarySkill({ name: skill.name }), tr("Skill 已卸载", "Skill removed"))}><Trash2 size={14} /></button> : <span className="extensions-state">{skill.source}</span>}
                      </span>
                      {verification[`skill:${skill.name}`] && <small className="extension-installed-verification" role="status">{verification[`skill:${skill.name}`]}</small>}
                    </div>
                  );
                }) : <div className="extensions-empty"><PackageOpen size={20} />{tr("还没有安装 Skill", "No Skills installed yet")}</div>}
              </div>

              <div className="extensions-section-title"><div><Box size={16} /><strong>MCP Servers</strong></div><span className="extensions-title-actions"><button type="button" disabled={busyId === "import:mcp"} onClick={() => void importMcp()}><Upload size={14} />{tr("导入", "Import")}</button><button type="button" onClick={() => configureTemplate()}><Plus size={14} />{tr("添加", "Add")}</button></span></div>
              <div className="extensions-item-list">
                {configuredMcp.length ? configuredMcp.map((server) => (
                  <div className="extensions-item" key={server.id}>
                    <span><Box size={14} /></span><div><strong>{server.name || server.id}</strong><small>{server.id} · {server.transport} · {server.enabled ? tr("已配置，尚未验证调用", "Configured, calls not verified") : tr("已停用", "Disabled")}</small>{!!server.missingEnvironment?.length && <small className="extensions-error">{tr("缺少环境变量", "Missing environment")}: {server.missingEnvironment.join(", ")}</small>}</div>
                    <span className="extensions-row-actions">
                    <button className="extension-icon-action extension-text-action" type="button" disabled={!!busyId || !!server.missingEnvironment?.length} title={tr("启动服务并发现工具，可能下载依赖；不调用业务工具", "Start the service and discover tools; may download dependencies. No action tools are called.")} onClick={() => void runLibraryAction(`probe:${server.id}`, async () => {
                      setVerification((v) => ({ ...v, [`mcp:${server.id}`]: "" }));
                      try {
                        const r = await window.desktop.core.probeLibraryMcp({ id: server.id });
                        setVerification((v) => ({ ...v, [`mcp:${server.id}`]: tr("发现 {count} 个工具 · 探测连接已关闭 · 业务调用未验证", "{count} tools discovered · Probe closed · Action calls untested", { count: r.toolCount }) + ` · ${new Date(r.checkedAt || Date.now()).toLocaleString()}` })); return r;
                      } catch (error) { setVerification((v) => ({ ...v, [`mcp:${server.id}`]: tr("探测失败：", "Probe failed: ") + error.message })); throw error; }
                    }, (result) => tr("发现 {count} 个工具，探测连接已关闭；不代表实际业务调用已验证。", "Discovered {count} tools; probe connection closed. Action calls have not been verified.", { count: result.toolCount }))}>{busyId === `probe:${server.id}` ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}{tr("探测", "Probe")}</button>
                    <Switch checked={server.enabled} disabled={!!busyId} label={tr("后续任务启用 {name}", "Enable {name} for future tasks", { name: server.name || server.id })} onChange={(enabled) => void runLibraryAction(`mcp:${server.id}`, () => window.desktop.core.toggleLibraryMcp({ id: server.id, enabled }), tr("设置已保存，后续任务生效；进行中任务不受影响。", "Saved for future tasks; running tasks are unchanged."))} />
                    <button className="extension-icon-action danger" type="button" disabled={!!busyId} title={tr("移除", "Remove")} onClick={() => void runLibraryAction(`mcp:${server.id}`, () => window.desktop.core.removeLibraryMcp({ id: server.id }), tr("MCP Server 已移除", "MCP server removed"))}><Trash2 size={14} /></button>
                    </span>
                    {verification[`mcp:${server.id}`] && <small className="extension-installed-verification" role="status">{verification[`mcp:${server.id}`]}</small>}
                  </div>
                )) : <div className="extensions-empty"><PackageOpen size={20} />{tr("还没有配置 MCP Server", "No MCP servers configured yet")}</div>}
              </div>
              {!!state.mcp?.errors?.length && <p className="extensions-error">{state.mcp.errors.join("; ")}</p>}
            </div>
          )}

          {tab === "sources" && (
            <div className="extensions-sources-view">
              <div className="extensions-summary-grid">
                {Object.entries(state.summary?.bySource || {}).filter(([, count]) => Number(count) > 0).map(([source, count]) => (
                  <article className="extension-summary-card" key={source}><span><SourceIcon source={source} /></span><div><strong>{sourceLabel(source, tr)}</strong><small>{tr("{count} 项能力", "{count} capabilities", { count })}</small></div></article>
                ))}
              </div>
              <div className="extensions-item-list policy-list">
                {MANAGED_SOURCES.map((source) => {
                  const userEnabled = state.policy?.sources?.[source] !== false;
                  const projectDisabled = state.policy?.projectDisabled?.includes(source);
                  const effective = state.policy?.effective?.[source] !== false;
                  return <div className="extensions-item" key={source}><span><SourceIcon source={source} /></span><div><strong>{sourceLabel(source, tr)}</strong><small>{projectDisabled ? tr("当前项目已停用", "Disabled by this project") : effective ? tr("当前可用", "Available") : tr("已在用户设置中停用", "Disabled in user settings")}</small></div><Switch checked={userEnabled} disabled={savingSource === source} label={`Toggle ${source}`} onChange={(enabled) => void setSourceEnabled(source, enabled)} /></div>;
                })}
              </div>
              <div className="extensions-trust-note"><ShieldCheck size={17} /><div><strong>{tr("信任边界保持不变", "Trust boundaries stay intact")}</strong><p>{tr("Library 只写入用户级 Skill 目录和 MCP 配置。工具仍由 Harness Permission、Approval 与项目策略逐层约束。", "The Library only writes the user Skill directory and MCP configuration. Harness Permission, Approval, and project policy still constrain every tool.")}</p></div></div>
            </div>
          )}

          {showMcpForm && (
            <div className="extensions-form-backdrop" role="presentation">
              <form className="extensions-mcp-form" onSubmit={(event) => void saveMcp(event)}>
                <div className="extensions-form-heading"><div><span>MCP</span><h4>{tr("连接可信工具服务", "Connect a trusted tool server")}</h4><p>{tr("只保存配置，不会在安装阶段执行命令。", "Configuration is saved without executing anything during installation.")}</p></div><button type="button" onClick={() => setShowMcpForm(false)}>×</button></div>
                <div className="extensions-field-grid">
                  <label><span>ID</span><input required pattern="[a-z][a-z0-9_-]{1,47}" value={mcpDraft.id} onChange={(event) => setMcpDraft((current) => ({ ...current, id: event.target.value.toLowerCase() }))} placeholder="my-server" /></label>
                  <label><span>{tr("名称", "Name")}</span><input value={mcpDraft.name} onChange={(event) => setMcpDraft((current) => ({ ...current, name: event.target.value }))} placeholder="My MCP" /></label>
                </div>
                <label><span>{tr("传输方式", "Transport")}</span><select value={mcpDraft.transport} onChange={(event) => setMcpDraft((current) => ({ ...current, transport: event.target.value }))}><option value="streamable-http">Streamable HTTP</option><option value="stdio">Local stdio</option></select></label>
                {mcpDraft.transport === "stdio" ? <><label><span>{tr("命令", "Command")}</span><input required value={mcpDraft.command} onChange={(event) => setMcpDraft((current) => ({ ...current, command: event.target.value }))} placeholder="npx" /></label><label><span>{tr("参数（每行一个）", "Arguments (one per line)")}</span><textarea rows={4} value={mcpDraft.argsText} onChange={(event) => setMcpDraft((current) => ({ ...current, argsText: event.target.value }))} /></label></> : <label><span>URL</span><input required type="url" value={mcpDraft.url} onChange={(event) => setMcpDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" /></label>}
                <label><span>{mcpDraft.transport === "stdio" ? tr("环境变量 JSON", "Environment JSON") : tr("请求头 JSON", "Headers JSON")}</span><textarea rows={4} value={mcpDraft.secretsText} onChange={(event) => setMcpDraft((current) => ({ ...current, secretsText: event.target.value }))} placeholder={'{ "Authorization": "Bearer ${MCP_TOKEN}" }'} /><small>{tr("推荐使用 ${ENV_NAME} 引用，不要把密钥提交到项目。", "Prefer ${ENV_NAME} references; never commit secrets to a project.")}</small></label>
                <label className="extensions-inline-switch"><Switch checked={mcpDraft.autoApproveReadOnly} label="Auto approve read-only" onChange={(checked) => setMcpDraft((current) => ({ ...current, autoApproveReadOnly: checked }))} /><span>{tr("自动批准服务声明为只读的工具", "Auto-approve tools declared read-only by the server")}</span></label>
                <label className="extensions-inline-switch"><Switch checked={mcpDraft.enabled} label="Enable for future tasks" onChange={(checked) => setMcpDraft((current) => ({ ...current, enabled: checked }))} /><span>{tr("后续任务启用（建议先保存并探测）", "Enable for future tasks (save and probe first)")}</span></label>
                <div className="extensions-form-actions"><button type="button" onClick={() => setShowMcpForm(false)}>{tr("取消", "Cancel")}</button><button className="primary" type="submit" disabled={busyId.startsWith("mcp:")}>{busyId.startsWith("mcp:") ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{tr("保存配置", "Save configuration")}</button></div>
              </form>
            </div>
          )}

          {state.error && <p className="extensions-error">{state.error}</p>}
          {state.skillDiagnostics?.map((item) => <p key={item.path} className="extensions-error">{item.path}: {item.error}</p>)}
        </>
      )}
    </section>
  );
}
