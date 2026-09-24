import { useState } from "react";
import { BookOpen } from "lucide-react";
import { useI18n } from "../i18n";
import { userGuideUrl } from "./guide-url.js";
import "./tutorial-link.css";

export function TutorialLink({ section = "" }) {
  const { language, tr } = useI18n();
  const [error, setError] = useState(false);
  const href = userGuideUrl(section);
  async function open(event) {
    if (!window.desktop?.links?.activate) return;
    event.preventDefault();
    setError(false);
    try {
      const result = await window.desktop.links.activate({ href, action: "open", language });
      if (result?.ok === false) throw new Error("Unable to open tutorial");
    } catch {
      setError(true);
    }
  }
  return <span className="tutorial-entry">
    <a className="tutorial-link" href={href} target="_blank" rel="noopener noreferrer" onClick={open}
      title={tr("在浏览器打开中文教程，无需登录", "Open the Chinese guide in your browser; no sign-in required")}>
      <BookOpen size={14} aria-hidden="true" />{section === "api-key" ? tr("API 添加教程", "API setup guide (中文)") : tr("使用教程", "User guide (中文)")}
    </a>
    {error && <span className="tutorial-link-error" role="alert">{tr("无法打开浏览器，请复制以下地址：", "Could not open the browser. Copy this URL: ")}{href}</span>}
  </span>;
}
