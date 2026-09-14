import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { Conversation } from "../../src/conversation/ConversationViews.jsx";
import "../../src/styles.css";
localStorage.setItem("aporiax.language.v1", "zh-CN");
const statuses = ["partial", "needs_input", "blocked", "completed", "failed", "interrupted"];
const task = { id: "fixture", messages: statuses.map((status) => ({ id: status, role: "assistant", status,
  content: status === "completed" ? "已交付 [成果](https://example.invalid/result)" : "状态测试", steps: [], changes: [],
  ...(status === "completed" ? { selfCheck: { delivery: { status: "unverified" } } } : {}) })) };
createRoot(document.getElementById("root")).render(<I18nProvider><Conversation task={task} /></I18nProvider>);
