import React from "react";
import { useI18n } from "../i18n";

export function ProviderProtocolFields({ form, setForm }) {
  const { tr } = useI18n();
  return <>
              <label>
                <span>{tr("请求协议", "Request protocol")}</span>
                <select className="text-field" aria-label="Provider protocol" value={form.protocol}
                  onChange={(event) => setForm((current) => ({ ...current, protocol: event.target.value }))}>
                  <option value="chat-completions">Chat Completions (compatible)</option>
                  <option value="deepseek-chat">DeepSeek native Chat</option>
                  <option value="responses">OpenAI Responses</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
                <small>{tr("只请求所选服务；不自动切换供应商。旧配置保持兼容协议。", "Only the selected endpoint is used; no provider fallback. Existing profiles keep their compatible protocol.")}</small>
              </label>
              {["responses", "anthropic-messages"].includes(form.protocol) && <label>
                <span>{tr("原生输出 Token 上限", "Native output token limit")}</span>
                <input className="text-field" type="number" min="256" max="128000" step="1" value={form.maxOutputTokens}
                  onChange={(event) => setForm((current) => ({ ...current, maxOutputTokens: event.target.value }))} />
              </label>}
              {form.protocol === "anthropic-messages" && <label>
                <span>{tr("Claude 思考协议（须与模型匹配）", "Claude thinking protocol (must match model)")}</span>
                <select className="text-field" aria-label="Anthropic thinking protocol" value={form.anthropicThinking}
                  onChange={(event) => setForm((current) => ({ ...current, anthropicThinking: event.target.value }))}>
                  <option value="adaptive">Adaptive</option><option value="manual">Manual budget (older models)</option>
                </select>
                {form.anthropicThinking === "manual" && <input aria-label="Thinking budget" className="text-field" type="number" min="1024" max="127999" value={form.thinkingBudget}
                  onChange={(event) => setForm((current) => ({ ...current, thinkingBudget: event.target.value }))} />}
                <small>{tr("任务开启思考时生效。手动预算须小于输出上限；不自动猜测或降级协议。", "Used when task thinking is enabled. Manual budget must be below output limit; protocols are not guessed or downgraded.")}</small>
              </label>}
  </>;
}
