import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { clampWorkbenchWidth, MIN_DIALOGUE_WIDTH, MIN_WIDTH } from "./state.js";
import { WorkbenchContent } from "./WorkbenchPanes.jsx";
import { WorkbenchTabs } from "./WorkbenchTabs.jsx";
import "./workbench.css";

function roomForWorkbench(shell) {
  const root = shell?.closest(".task-workspace");
  if (!root) return Number.POSITIVE_INFINITY;
  let other = 0;
  for (const child of root.children) {
    if (child === shell || child.classList.contains("thread")) continue;
    other += child.getBoundingClientRect().width;
  }
  return Math.max(0, root.clientWidth - other);
}

export function WorkbenchLayout({
  workbench,
  builtins,
  onNotice,
  onNeedWorkspace,
  overlaying,
}) {
  const { tr } = useI18n();
  const { layout, resources } = workbench;
  const shellRef = useRef(null);
  const roomRef = useRef(Number.POSITIVE_INFINITY);
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const active = layout.tabs.find((tab) => tab.id === layout.active) || null;
  const covered = overlaying || resizing || menuOpen;
  const displayWidth = clampWorkbenchWidth(layout.width, room);

  useEffect(() => {
    const shell = shellRef.current;
    const root = shell?.closest(".task-workspace");
    if (!shell || !root) return undefined;
    const apply = () => {
      const next = roomForWorkbench(shell);
      roomRef.current = next;
      setRoom(next);
    };
    const observer = new ResizeObserver(apply);
    observer.observe(root);
    for (const child of root.children) observer.observe(child);
    apply();
    return () => observer.disconnect();
  }, [overlaying]);

  const setWidth = (width) => {
    workbench.setLayout((current) => ({
      ...current,
      width: clampWorkbenchWidth(width, roomRef.current),
    }));
  };

  const startResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setResizing(true);
    document.body.classList.add("panel-is-resizing");
    const start = event.clientX;
    const origin = displayWidth;
    const handleMove = (moveEvent) => {
      setWidth(origin + start - moveEvent.clientX);
    };
    const finish = () => {
      setResizing(false);
      document.body.classList.remove("panel-is-resizing");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const handleKeyDown = (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth(displayWidth + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(displayWidth - 16);
    }
  };

  const openOrBind = (kind) => {
    if ((kind === "workspace" || kind === "understanding" || kind === "file") && !workbench.task.workspacePath) {
      onNeedWorkspace?.();
      return;
    }
    if (kind === "file") {
      workbench.open("workspace");
      return;
    }
    workbench.open(kind);
  };

  return (
    <div
      ref={shellRef}
      className={`workbench-shell${resizing ? " workbench-is-resizing" : ""}`}
      data-dock="right"
      style={{ flexBasis: `${displayWidth}px`, width: displayWidth }}
    >
      <div
        className="workbench-resizer"
        role="separator"
        tabIndex={0}
        data-orientation="vertical"
        aria-label={tr("调整侧栏宽度", "Resize sidebar")}
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.max(MIN_WIDTH, Number.isFinite(room) ? room - MIN_DIALOGUE_WIDTH : 1600)}
        aria-valuenow={Math.round(displayWidth)}
        onPointerDown={startResize}
        onKeyDown={handleKeyDown}
        onDoubleClick={workbench.restoreSize}
      >
        <span />
      </div>
      <section className="workbench-panel" aria-label={tr("工作侧栏", "Workbench sidebar")}>
        <WorkbenchTabs
          layout={layout}
          resources={resources}
          onSelect={workbench.select}
          onClose={workbench.close}
          onReorder={workbench.reorder}
          onCreate={workbench.create}
          onOpen={openOrBind}
          onCollapse={workbench.collapse}
          onOverlayChange={setMenuOpen}
        />
        {workbench.error ? <div className="workbench-error" role="alert">{workbench.error}</div> : null}
        <div className="workbench-body">
          <WorkbenchContent
            tab={active}
            task={workbench.task}
            resource={active ? resources[active.id] : null}
            workbench={workbench}
            builtins={builtins}
            onNotice={onNotice}
            onNeedWorkspace={onNeedWorkspace}
            covered={covered}
          />
        </div>
      </section>
    </div>
  );
}
