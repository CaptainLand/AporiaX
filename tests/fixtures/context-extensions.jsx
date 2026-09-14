import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { UnderstandingControls } from "../../src/settings/UnderstandingControls.jsx";
import { ExtensionNotices } from "../../src/conversation/RuntimeMessageUI.jsx";
import { reduceHarnessTaskEvent } from "../../src/state/harness-event-reducer.js";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
localStorage.setItem("aporiax.language.v1", params.get("lang") || "zh-CN");
document.documentElement.dataset.theme = params.get("theme") || "light";
let saved = { settings: { useForContext: false, autoCurate: false }, facts: [{ content: "Saved database knowledge" }] };
window.fixture = { fail: false, saves: [] };
window.desktop = { understanding: { async setSettings(request) {
  window.fixture.saves.push(request);
  if (window.fixture.fail) throw new Error("Settings write failed");
  saved = { ...saved, settings: { ...saved.settings, ...request.settings } };
  return structuredClone(saved);
} } };
function Fixture() {
  const [state, setState] = useState(saved);
  const [tasks, setTasks] = useState([{ id: "task", messages: [{ id: "answer", role: "assistant", status: "completed" }] }]);
  window.fixture.emit = (event) => setTasks((current) => reduceHarnessTaskEvent(current, { taskId: "task", assistantId: "answer" }, event));
  return <div className="understanding-view" style={{ maxWidth: 780 }}>
    <UnderstandingControls workspacePath="D:/fixture" state={state} onChange={setState} />
    <p>{state.facts[0].content}</p>
    <ExtensionNotices message={tasks[0].messages[0]} />
  </div>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
