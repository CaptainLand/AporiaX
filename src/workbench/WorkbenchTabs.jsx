import { useEffect, useRef, useState } from "react";
import {
  FileText,
  GitCompare,
  GitBranch,
  Globe,
  MessagesSquare,
  Plus,
  PanelRightClose,
  TerminalSquare,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";

const TITLES = {
  route: "Route",
  workspace: "Workspace",
  understanding: "Understanding",
  browser: "Browser",
  terminal: "Terminal",
  process: "Process",
  file: "File",
  sidechat: "侧边聊天",
  git: "Git",
};

export function WorkbenchTabs({
  layout,
  resources,
  onSelect,
  onClose,
  onReorder,
  onCreate,
  onOpen,
  onCollapse,
  onOverlayChange,
}) {
  const { tr } = useI18n();
  const [plusOpen, setPlusOpen] = useState(false);
  const dragId = useRef("");
  const plusRef = useRef(null);

  useEffect(() => {
    onOverlayChange?.(plusOpen);
    return () => onOverlayChange?.(false);
  }, [plusOpen]);

  useEffect(() => {
    if (!plusOpen) return undefined;
    const close = (event) => {
      if (plusRef.current && !plusRef.current.contains(event.target)) {
        setPlusOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setPlusOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

  return (
    <div className="workbench-chrome">
      <div className="workbench-tabs" role="tablist" aria-label={tr("工作台标签", "Workbench tabs")}>
        {layout.tabs.map((tab) => {
          const resource = resources[tab.id];
          return (
            <button
              className={`workbench-tab ${layout.active === tab.id ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={layout.active === tab.id}
              draggable
              key={tab.id}
              title={tab.path || resource?.url || tab.title}
              onClick={() => onSelect(tab.id)}
              onDragStart={() => {
                dragId.current = tab.id;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId.current && dragId.current !== tab.id) onReorder(dragId.current, tab.id);
                dragId.current = "";
              }}
            >
              {tab.kind === "terminal" ? <TerminalSquare size={12} /> : resource && resource.status !== "exited" && resource.status !== "closed" ? (
                <span className={`workbench-tab-dot ${resource.owner === "user" ? "warn" : ""}`} />
              ) : null}
              <span className="workbench-tab-title">{tab.title || TITLES[tab.kind] || tab.kind}</span>
              <span
                className="workbench-tab-close"
                role="button"
                tabIndex={0}
                aria-label={tr("关闭标签", "Close tab")}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(tab.id);
                  }
                }}
              >
                <X size={11} />
              </span>
            </button>
          );
        })}
      </div>
      <div className="workbench-plus" ref={plusRef}>
        <button
          className="workbench-icon"
          type="button"
          aria-haspopup="menu"
          aria-expanded={plusOpen}
          title={tr("打开内容", "Open content")}
          onClick={() => setPlusOpen((open) => !open)}
        >
          <Plus size={15} />
        </button>
        {plusOpen ? (
          <div className="workbench-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { onOpen("sidechat"); setPlusOpen(false); }}>
              <MessagesSquare size={14} /> {tr("侧边聊天", "Side chat")}
            </button>
            <button type="button" role="menuitem" onClick={() => { onOpen("route"); setPlusOpen(false); }}>
              <GitCompare size={14} /> {tr("变更", "Changes")}
            </button>
            <button type="button" role="menuitem" onClick={() => { onCreate("browser"); setPlusOpen(false); }}>
              <Globe size={14} /> Browser
            </button>
            <button type="button" role="menuitem" onClick={() => { onCreate("terminal"); setPlusOpen(false); }}>
              <TerminalSquare size={14} /> {tr("终端", "Terminal")}
            </button>
            <button type="button" role="menuitem" onClick={() => { onOpen("file"); setPlusOpen(false); }}>
              <FileText size={14} /> {tr("文件", "File")}
            </button>
            <button type="button" role="menuitem" onClick={() => { onOpen("git"); setPlusOpen(false); }}>
              <GitBranch size={14} /> Git
            </button>
          </div>
        ) : null}
      </div>
      <button
        className="workbench-icon"
        type="button"
        title={tr("收起侧栏", "Collapse sidebar")}
        onClick={onCollapse}
      >
        <PanelRightClose size={14} />
      </button>
    </div>
  );
}
