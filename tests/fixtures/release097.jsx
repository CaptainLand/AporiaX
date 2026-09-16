import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { GitPane } from "../../src/workbench/GitPane.jsx";
import { OcrDialog } from "../../src/workbench/OcrDialog.jsx";
import "../../src/styles.css";
const meta = await fetch("/__097/meta").then((value) => value.json());
localStorage.setItem("aporiax.language.v1", "zh-CN");
const bridge = async (input) => {
  if (input.source?.data instanceof ArrayBuffer) input = { ...input, source: { ...input.source, data: Array.from(new Uint8Array(input.source.data)) } };
  const response = await fetch("/__097/request", { method: "POST", body: JSON.stringify(input) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
};
window.desktop = { ocr: { request: (input) => bridge({ ...input, action: "ocr" }) } };
const workbench = { key: "fixture", draft: () => "", saveDraft() {}, dirty: { current: new Set() }, request: bridge, openFile() {}, openBrowser(url) { window.openedPr = url; } };
function Fixture() {
  const [open, setOpen] = useState(false);
  return <><style>{`body { background: #f8f7f8; } .fixture-tools { height:50px;display:flex;gap:12px;padding:8px; } .fixture-tools button { border-radius:8px;padding:6px 12px;cursor:pointer; } .fixture-git { height:calc(100vh - 50px);width:min(480px,100%); }`}</style>
    <div className="fixture-tools"><button onClick={() => setOpen(true)}>测试 OCR</button><button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"}>切换主题</button></div>
    <div className="fixture-git"><GitPane workbench={workbench} /></div>
    {open && <OcrDialog source={{ name: "mixed.pdf", base64: meta.pdf }} onClose={() => setOpen(false)} onAttach={(attachment) => { window.ocrAttachment = attachment; }} />}
  </>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
