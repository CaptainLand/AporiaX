import { createContext, useContext, useEffect, useRef, useState } from "react";
import { classifyLink } from "../../electron/link-target.js";
import {
  closeTab,
  draftKey,
  drafts,
  dropMissingSessionTabs,
  loadLayout,
  normalizeLayout,
  openTab,
  moveTab,
  persistableLayout,
  sameScope,
  saveLayout,
  scopeKey,
  setFollow,
  DEFAULT_WIDTH,
} from "./state.js";

export const WorkbenchContext = createContext(null);
export const useWorkbenchContext = () => useContext(WorkbenchContext);

export function useWorkbench(task) {
  const key = scopeKey(task);
  const keyRef = useRef(key);
  const resourcesRef = useRef({});
  const layoutGen = useRef(0);
  const [layout, setLayout] = useState(() => loadLayout(key));
  const [resources, setResources] = useState({});
  const [error, setError] = useState("");
  const [covered, setCovered] = useState(false);
  const dirty = useRef(new Set());

  const request = (data) => {
    if (!window.desktop?.workbench) {
      return Promise.reject(new Error("此功能需要在 AporiaX 桌面端运行。"));
    }
    return window.desktop.workbench.request({
      ...data,
      taskId: task.id,
      workspacePath: task.workspacePath || "",
    });
  };

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      resourcesRef.current = {};
      setResources({});
      setError("");
      setLayout(loadLayout(key));
      void request({ action: "hide" }).catch(() => {});
      return;
    }
    try {
      saveLayout(key, layout);
    } catch {
      setError("布局无法保存：本地存储已满。");
    }
  }, [key, layout]);

  useEffect(() => {
    let disposed = false;
    const merge = (resource, automatic = false) => {
      if (disposed || !sameScope(resource, task)) return;
      const previous = resourcesRef.current[resource.id];
      const isNew = !previous;
      const claimed =
        resource.kind === "browser" &&
        resource.owner === "agent" &&
        previous?.owner !== "agent";
      const presented = resource.present === true;
      if (resource.kind === "file") {
        if (presented) {
          setLayout((current) =>
            openTab(
              current,
              {
                id: resource.id,
                kind: "file",
                title: resource.title,
                path: resource.path,
                line: resource.line,
                revision: Date.now(),
              },
              { automatic: true, force: true },
            ),
          );
        }
        return;
      }
      resourcesRef.current = { ...resourcesRef.current, [resource.id]: resource };
      setResources((all) => ({ ...all, [resource.id]: resource }));
      if (resource.status === "closed") return;
      if (presented || claimed) {
        setLayout((current) =>
          openTab(
            current,
            { id: resource.id, kind: resource.kind, title: resource.title },
            { automatic: true, force: true },
          ),
        );
      } else if (automatic && isNew && resource.kind === "browser") {
        setLayout((current) =>
          openTab(
            current,
            { id: resource.id, kind: resource.kind, title: resource.title },
            { automatic: true },
          ),
        );
      } else if (!isNew && resource.title) {
        setLayout((current) =>
          current.tabs.some((tab) => tab.id === resource.id)
            ? {
                ...current,
                tabs: current.tabs.map((tab) =>
                  tab.id === resource.id ? { ...tab, title: resource.title } : tab,
                ),
              }
            : current,
        );
      }
    };
    const unsubscribe = window.desktop?.workbench?.subscribe((resource) =>
      merge(resource, true),
    );
    if (window.desktop?.workbench) {
      request({ action: "list" })
        .then((items) => {
          if (disposed) return;
          const list = Array.isArray(items) ? items : [];
          setLayout((current) => dropMissingSessionTabs(current, new Set(list.map((item) => item.id))));
          list.forEach((resource) => merge(resource));
        })
        .catch((failure) => setError(failure.message));
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [key]);

  const open = (kind, value = {}) => {
    setLayout((current) =>
      openTab(current, {
        id: value.id || kind,
        kind,
        title:
          value.title ||
          ({ route: "Route", workspace: "Workspace", understanding: "Understanding" }[kind]) ||
          kind,
        ...value,
      }),
    );
  };

  const openFile = (path, line = 1) => {
    const normalized = String(path || "").replaceAll("\\", "/");
    if (!normalized) return;
    open("file", {
      id: `file:${normalized}`,
      title: normalized.split("/").at(-1),
      path: normalized,
      line,
    });
  };

  const create = async (kind) => {
    try {
      const resource = await request({ action: `new-${kind}` });
      resourcesRef.current = { ...resourcesRef.current, [resource.id]: resource };
      setResources((all) => ({ ...all, [resource.id]: resource }));
      open(kind, resource);
    } catch (failure) {
      setError(failure.message);
    }
  };

  const hideBrowser = () => {
    layoutGen.current += 1;
    return request({ action: "hide" }).catch(() => {});
  };

  const layoutBrowser = (id, rect, visible) => {
    const generation = ++layoutGen.current;
    if (!visible || !id) return hideBrowser();
    if (!resourcesRef.current[id]) return Promise.resolve({ missing: true });
    return request({
      action: "layout",
      id,
      rect,
      visible: true,
      generation,
    }).then((result) => {
      if (result?.missing) {
        setLayout((current) => dropMissingSessionTabs(current, new Set(Object.keys(resourcesRef.current))));
      }
      return result;
    }).catch((failure) => setError(failure.message));
  };

  return {
    task,
    key,
    layout,
    resources,
    error,
    setError,
    request,
    open,
    openFile,
    create,
    setLayout,
    dirty,
    covered,
    setCovered,
    hideBrowser,
    layoutBrowser,
    select: (id) => setLayout((current) => ({ ...current, active: id, open: true, follow: false })),
    reorder: (id, before) => setLayout((current) => moveTab(current, id, before)),
    close: (id) => {
      if (dirty.current.has(id) && !window.confirm("此文件有未保存修改。关闭标签并保留草稿？")) {
        return;
      }
      setLayout((current) => closeTab(current, id));
    },
    collapse: () => setLayout((current) => ({ ...current, open: false, follow: false })),
    expand: () => setLayout((current) => ({ ...current, open: true })),
    follow: (value) => setLayout((current) => setFollow(current, value)),
    restoreSize: () =>
      setLayout((current) =>
        normalizeLayout({
          ...persistableLayout(current),
          width: DEFAULT_WIDTH,
        }),
      ),
    async openHref(href) {
      const link = classifyLink(href);
      if (link?.kind === "web") {
        const resource = await request({ action: "new-browser" });
        resourcesRef.current = { ...resourcesRef.current, [resource.id]: resource };
        setResources((all) => ({ ...all, [resource.id]: resource }));
        open("browser", resource);
        await request({ action: "navigate", id: resource.id, url: href });
        return true;
      }
      if (link?.kind === "file") {
        openFile(link.target, link.line);
        return true;
      }
      return false;
    },
    draft: (id) => drafts.get(draftKey(key, id)),
    saveDraft: (id, value) => {
      const stored = draftKey(key, id);
      if (value == null) drafts.delete(stored);
      else drafts.set(stored, value);
    },
  };
}
