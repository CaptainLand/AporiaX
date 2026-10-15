import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { useWorkspaceMentionAutocomplete } from "../../src/composer/WorkspaceMentionAutocomplete.jsx";
import { isComposingKey } from "../../shared/mention-tokens.js";
import { Composer } from "../../src/composer/Composer.jsx";
import "../../src/styles.css";
localStorage.setItem("aporiax.language.v1", "zh-CN");
window.fixture = { files: ["old.txt", "目录/说明.md"], scans: 0, failSkills: false, sends: 0 };
window.desktop = {
  workspace: { async listTree() { window.fixture.scans++; return { entries: window.fixture.files.map(path => ({ type: "file", path })) }; } },
  core: { async skills() { if(window.fixture.failSkills) throw new Error("Skill unavailable"); return { skills: [{ name: "x", description: "Fixture skill" }] }; },
    async mcp() { return { servers: [{ id: "docs", name: "Docs", transport: "stdio" }] }; } },
};
function Fixture() {
  const [value, setValue] = useState(""), [workspacePath, setWorkspace] = useState("D:/fixture");
  const textareaRef = useRef(null);
  const mention = useWorkspaceMentionAutocomplete({ value, setValue, textareaRef, workspacePath, taskId: "task" });
  return <><button onClick={() => { setValue(""); setWorkspace(""); }}>No workspace</button>
    <textarea aria-label="fixture-input" ref={textareaRef} value={value} onChange={e => setValue(e.target.value)}
      onKeyDown={e => { if(isComposingKey(e)) return; if(mention.handleKeyDown(e)) return; if(e.key === "Enter") window.fixture.sends++; }} />
    {mention.menu}
    <Composer task={{ id: "ime-composer", workspacePath: "", providerId: "fake", modelId: "test", effort: "high" }}
      providers={[{ id: "fake", name: "Fake", models: [{ id: "test", name: "Test" }] }]}
      onSend={() => { window.fixture.sends++; return true; }} onUpdateTask={() => {}} onNotice={() => {}} onManageProviders={() => {}} />
    </>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
