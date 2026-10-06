import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { Composer } from "../../src/composer/Composer.jsx";
import { WorkbenchLayout } from "../../src/workbench/WorkbenchLayout.jsx";
import { CollapsedDropRail } from "../../src/workbench/CollapsedDropRail.jsx";
import { useWorkbench, WorkbenchContext } from "../../src/workbench/use-workbench.js";
import "../../src/styles.css";

localStorage.clear();
localStorage.setItem("aporiax.language.v1", "zh-CN");
window.notices = [];
window.desktop = {
  workbench: {
    subscribe: () => () => {},
    request: async () => true,
  },
};

const providers = [
  {
    id: "fake",
    name: "Fake",
    models: [
      {
        id: "vision",
        name: "Vision",
        shortName: "Vision",
        supportsImages: true,
        supportsThinking: true,
        supportsTools: true,
      },
    ],
  },
];
const reasoningFixture = new URLSearchParams(location.search).get("reasoning");
const hintState = new URLSearchParams(location.search).get("hintState");
if (hintState === "locked") providers.splice(0);
if (reasoningFixture) providers[0].models.push({ id: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5", supportsThinking: false, thinkingMode: "none", supportsTools: true });

function Fixture() {
  const [task, setTask] = useState({
    id: "fixture",
    title: "Composer",
    workspacePath: "D:/Fixture",
    workspaceName: "Fixture",
    providerId: "fake",
    modelId: reasoningFixture === "claude" ? "claude-opus-5-5" : "vision",
    thinking: false,
    effort: "high",
    builderLimit: 2,
    messages: [],
  });
  const workbench = useWorkbench(task);
  window.wb = workbench;
  window.fixtureTask = task;
  return (
    <WorkbenchContext.Provider value={workbench}>
      <div className={`task-workspace${workbench.layout.open ? " workbench-open" : ""}`} style={{ display: "flex", height: "100vh", position: "relative" }}>
        <section className="thread" style={{ flex: 1, minWidth: 420, padding: 24 }}>
          <header className="thread-header">
            <div className="thread-actions">
              <button type="button" className="theme-toggle">主题</button>
            </div>
          </header>
          {/* Match the app's bottom-docked composer so upward menus fit on screen. */}
          <div className="thread-body" style={{ flex: "1 1 auto", minHeight: 0 }} />
          <Composer
            task={task}
            providers={providers}
            onSend={() => { window.fixtureSendCount = (window.fixtureSendCount || 0) + 1; return true; }}
            onStop={() => {}}
            onPause={() => {}}
            onResume={() => {}}
            onUpdateTask={(patch) => setTask((current) => ({ ...current, ...patch }))}
            onNotice={(message) => window.notices.push(message)}
            isRunning={hintState === "running" || hintState === "paused"}
            isPaused={hintState === "paused"}
          />
        </section>
        {workbench.layout.open ? (
          <WorkbenchLayout
            workbench={workbench}
            overlaying={false}
            onNotice={(message) => window.notices.push(message)}
            builtins={{ workspace: <div>Workspace</div> }}
          />
        ) : (
          <CollapsedDropRail
            workbench={workbench}
            onNotice={(message) => window.notices.push(message)}
          />
        )}
      </div>
    </WorkbenchContext.Provider>
  );
}

createRoot(document.getElementById("root")).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
