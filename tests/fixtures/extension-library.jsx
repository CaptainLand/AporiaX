import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { ExtensionsSettings } from "../../src/settings/ExtensionsSettings.jsx";
import "../../src/styles.css";
localStorage.setItem("aporiax.language.v1", "zh-CN");
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "light";
window.fixture = { fail: false, saves: [], toggles: [], probes: [], rollbacks: [], searches: [], installs: [], verifies: [] };
let enabled = false;
window.desktop = { core: {
  searchOnlineExtensions: async (request) => {
    window.fixture.searches.push(request);
    if (request.query === "fail") throw new Error("Online catalog unavailable");
    const entries = [{ kind: request.kind, title: request.kind === "skill" ? "Word report writer" : "Document MCP", source: "example/document-tools", selector: { kind: request.kind, name: request.query } }];
    if (request.query === "slow") await new Promise((resolve) => { window.fixture.resolveSlowSearch = resolve; });
    return { source: request.kind === "skill" ? "skills.sh" : "MCP Registry", entries };
  },
  onlineExtensionDetails: async (request) => ({ kind: request.kind, title: request.kind === "skill" ? "Word report writer" : "Document MCP", ticket: "fixture-ticket", name: "word-report", sourceUrl: "https://github.com/example/document-tools/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/word-report", version: "a".repeat(40), license: "MIT", licenseText: "MIT License — fixture, not a real upstream package.", requirements: ["Python >= 3.10", "python-docx / lxml"], warning: "第三方内容未经安全审核。安装不执行脚本。", dependencies: [{ path: "requirements.txt", text: "python-docx==1.2.0" }], manifest: "---\nname: word-report\ndescription: A Word report workflow.\n---\n# Format the report\n<script>alert(1)</script>", files: ["SKILL.md", "scripts/render.py", "requirements.txt"], fileCount: 3, choices: [{ label: "Remote HTTP", requirements: ["DOCS_TOKEN"], template: { id: "docs-remote", name: "Document MCP", transport: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } }] }),
  installOnlineSkill: async (request) => { window.fixture.installs.push(request); return { skill: { name: "word-report" }, verification: { fileCount: 3, checkedAt: new Date().toISOString(), dependenciesVerified: false } }; },
  verifyLibrarySkill: async (request) => { window.fixture.verifies.push(request); return { fileCount: 3, checkedAt: new Date().toISOString() }; },
  skills: async () => ({ skills: [{ name: "custom", title: "测试工作流", source: "user", auto: false }] }),
  mcp: async () => ({ allServers: [{ id: "docs", name: "文档服务", transport: "stdio", enabled, missingEnvironment: [] }, { id: "github", name: "GitHub", transport: "streamable-http", enabled: false, missingEnvironment: ["GITHUB_MCP_TOKEN"] }], errors: ["Unsupported MCP transport: legacy-sse"] }),
  library: async () => ({ installed: { skillPackages: [{ name: "custom", canRollback: true }] }, catalog: { entries: [{ id: "mcp.context7", type: "mcp-template", title: "Context7", requirements: ["CONTEXT7_API_KEY"], template: { id: "context7", transport: "streamable-http", url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer ${CONTEXT7_API_KEY}" } } }] } }),
  saveLibraryMcp: async (request) => { if (window.fixture.fail) throw new Error("Cannot save config"); window.fixture.saves.push(request); },
  toggleLibraryMcp: async (request) => { window.fixture.toggles.push(request); enabled = request.enabled; },
  probeLibraryMcp: async (request) => { window.fixture.probes.push(request); return { toolCount: 7, connected: false }; },
  rollbackLibrarySkill: async (request) => { window.fixture.rollbacks.push(request); },
  importLibraryMcp: async () => ({ imported: [{ id: "new" }], errors: ["existing id preserved"] }),
} };
function Fixture() {
  const [notice, setNotice] = useState("");
  return <div style={{ maxWidth: 800, padding: 12 }}><div role="status">{notice}</div><ExtensionsSettings workspacePath="D:/fixture" onNotice={setNotice} /></div>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
