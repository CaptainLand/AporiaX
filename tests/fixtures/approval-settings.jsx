import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { SettingsPanel } from "../../src/settings/SettingsPanel.jsx";
import { PermissionsSettings } from "../../src/settings/PermissionsSettings.jsx";
import { getDefaultTaskConfig } from "../../src/models/model-catalog.js";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
localStorage.setItem("aporiax.language.v1", params.get("lang") || "zh-CN");
document.documentElement.dataset.theme = params.get("theme") || "light";
window.recoveryOpenCount = 0;
window.desktop = { sandbox: { openRecovery: async () => { window.recoveryOpenCount++; } } };
function Fixture() {
  const [task, setTask] = useState({ ...getDefaultTaskConfig([]), id: "test", approvalMode: "sandbox-auto", workspaceName: "Test", workspacePath: "D:/Test", ...(params.has("execution") ? { executionMode: params.get("execution") || undefined } : {}) });
  window.approvalFixture = task;
  if (params.has('permissions')) return <div style={{ width: Number(params.get('width')) || 580, maxWidth: '100%', padding: 12 }}>
    <PermissionsSettings task={task} onUpdateTask={value => setTask(old => ({ ...old, ...value }))} sandboxStatus={{ available: false }} />
  </div>;
  return <SettingsPanel style={{ width: Number(params.get("width")) || 304, height: "100vh" }} task={task} providers={[]} onUpdateTask={(value) => setTask((old) => ({ ...old, ...value }))} sandboxStatus={{ localAvailable: true, available: false }} onClose={() => {}} />;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
