import { isComposingKey } from "../../shared/mention-tokens.js";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Box, FileText, LoaderCircle, Sparkles } from "lucide-react";
import {
  extractWorkspaceMentionQuery,
  rankWorkspaceFiles,
  replaceWorkspaceMentionQuery,
} from "../agent-process-model.js";
import { useI18n } from "../i18n";
import "../agent-process-mentions.css";

const workspaceFileIndexes = new Map();
const extensionMentionIndexes = new Map();
const EMPTY_STATE = Object.freeze({
  query: null,
  suggestions: [],
  selectedIndex: 0,
  loading: false,
});

async function buildWorkspaceFileIndex(workspacePath) {
  if (!workspacePath || !window.desktop?.workspace?.listTree) return [];
  const cached = workspaceFileIndexes.get(workspacePath);
  if (cached && (!cached.settled || Date.now() - cached.createdAt < 1500)) return cached.promise;

  const promise = (async () => {
    const files = [];
    const queue = ["."];
    const visited = new Set();
    while (queue.length && visited.size < 260 && files.length < 4_000) {
      const directory = queue.shift();
      if (!directory || visited.has(directory)) continue;
      visited.add(directory);
      let result;
      try {
        result = await window.desktop.workspace.listTree(
          workspacePath,
          directory,
        );
      } catch {
        continue;
      }
      for (const entry of result?.entries || []) {
        if (entry?.type === "file") {
          files.push(String(entry.path || "").replace(/\\/g, "/"));
          if (files.length >= 4_000) break;
        } else if (entry?.type === "directory" && entry.path) {
          files.push(String(entry.path).replace(/\\/g, "/") + "/");
          queue.push(entry.path);
        }
      }
    }
    const paths = [...new Set(files)].filter(Boolean);
    paths.truncated = queue.length > 0 || files.length >= 4_000;
    return paths;
  })();

  const entry = { createdAt: Date.now(), promise, settled: false };
  workspaceFileIndexes.set(workspacePath, entry);
  if (workspaceFileIndexes.size > 20) workspaceFileIndexes.delete(workspaceFileIndexes.keys().next().value);
  try {
    const paths = await promise;
    entry.settled = true; entry.createdAt = Date.now();
    return paths;
  } catch (error) {
    workspaceFileIndexes.delete(workspacePath);
    throw error;
  }
}

function invalidateExtensionIndex(workspacePath) {
  for (const kind of ["skill", "mcp"]) extensionMentionIndexes.delete(`${workspacePath}\0${kind}`);
}

async function buildExtensionMentionIndex(workspacePath, kind) {
  const key = `${workspacePath}\0${kind}`;
  const cached = extensionMentionIndexes.get(key);
  if (cached && Date.now() - cached.createdAt < 10_000) return cached.promise;
  const promise = Promise.resolve().then(() => kind === "skill"
    ? window.desktop?.core?.skills?.({ workspacePath }) : window.desktop?.core?.mcp?.({ workspacePath }))
    .then(result => kind === "skill" ? (result?.enabled === false ? [] : result?.skills || []).map((skill) => ({
      key: `skill:${skill.name}`,
      kind: "skill",
      label: skill.title || skill.name,
      token: `skill:${skill.name}`,
      description: skill.description || skill.source || "Skill",
    })) : (result?.enabled === false ? [] : result?.servers || []).filter(server => server.enabled !== false).map((server) => ({
      key: `mcp:${server.id}`,
      kind: "mcp",
      label: server.name || server.id,
      token: `mcp:${server.id}`,
      description: `${server.id} · ${server.transport}`,
    }))).catch(error => { extensionMentionIndexes.delete(key); throw error; });
  extensionMentionIndexes.set(key, { createdAt: Date.now(), promise });
  if (extensionMentionIndexes.size > 40) extensionMentionIndexes.delete(extensionMentionIndexes.keys().next().value);
  return promise;
}

function rankMentionSuggestions(paths, extensions, query, limit = 12) {
  const source = String(query || "").toLowerCase();
  const explicitKind = source.startsWith("skill:")
    ? "skill"
    : source.startsWith("mcp:") ? "mcp" : ["browser", "terminal", "git"].find((kind) => source.startsWith(kind + ":")) || "";
  const needle = explicitKind ? source.slice(explicitKind.length + 1) : source;
  const extensionMatches = extensions
    .filter((item) => !explicitKind || item.kind === explicitKind)
    .filter((item) => !needle || `${item.label} ${item.token} ${item.description}`.toLowerCase().includes(needle))
    .slice(0, explicitKind ? limit : 4);
  if (explicitKind) return extensionMatches;
  const files = rankWorkspaceFiles(paths, needle, Math.max(1, limit - extensionMatches.length))
    .map((path) => ({
      key: `file:${path}`,
      kind: "file",
      label: path,
      token: path,
      description: "",
    }));
  return [...extensionMatches, ...files].slice(0, limit);
}

function WorkspaceMentionMenu({ state, onSelect }) {
  const { tr } = useI18n();
  return (
    <div className="aporiax-workspace-mention-host">
      <div className="aporiax-workspace-mention-menu" role="listbox">
        <div className="aporiax-workspace-mention-title">
          <span>
            <FileText size={13} />
            {tr("引用文件、目录或扩展", "Mention files, folders, or extensions")}
          </span>
          <small>
            {"@skill: / @mcp: / @git: / @browser: / @terminal:"}
          </small>
        </div>
        {state.loading ? (
          <div className="aporiax-workspace-mention-empty">
            <LoaderCircle className="spin" size={13} />
            {tr("正在索引工作区…", "Indexing workspace…")}
          </div>
        ) : state.suggestions.length ? (
          <div className="aporiax-workspace-mention-results">
            {state.suggestions.map((suggestion, index) => (
              <button
                className={index === state.selectedIndex ? "active" : ""}
                key={suggestion.key}
                type="button"
                role="option"
                aria-selected={index === state.selectedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(suggestion)}
              >
                {suggestion.kind === "skill" ? <Sparkles size={13} /> : suggestion.kind === "mcp" ? <Box size={13} /> : <FileText size={13} />}
                <span><strong>{suggestion.label}</strong>{suggestion.description ? <small>{suggestion.description}</small> : null}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="aporiax-workspace-mention-empty">
            {tr("没有匹配的文件或扩展", "No matching files or extensions")}
          </div>
        )}
        {state.truncated && <div className="aporiax-workspace-mention-empty">{tr("结果已截断；可缩小路径或直接输入完整引用。", "Results truncated; narrow the path or type an exact reference.")}</div>}
        <div className="aporiax-workspace-mention-footer">
          <span>↑↓ {tr("选择", "Select")}</span>
          <span>Enter / Tab {tr("引用", "Mention")}</span>
          <span>Esc {tr("关闭", "Close")}</span>
        </div>
      </div>
    </div>
  );
}

export function useWorkspaceMentionAutocomplete({
  value,
  setValue,
  textareaRef,
  workspacePath,
  taskId,
}) {
  const [state, setState] = useState(EMPTY_STATE);
  const [cursorRevision, setCursorRevision] = useState(0);
  const requestRevision = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const close = useCallback(() => {
    requestRevision.current += 1;
    workspaceFileIndexes.delete(workspacePath);
    setState(EMPTY_STATE);
  }, [workspacePath]);

  const refreshCursor = useCallback(() => {
    setCursorRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const query = extractWorkspaceMentionQuery(value, cursor);
    if (!query) {
      close();
      return;
    }

    const revision = requestRevision.current + 1;
    requestRevision.current = revision;
    setState({
      query,
      suggestions: [],
      selectedIndex: 0,
      loading: true,
    });

    const timer = setTimeout(() => {
      const explicitKind = /^(skill|mcp|git|terminal|browser):/i.exec(query.query)?.[1].toLowerCase();
      let paths = [], pending = 0;
      const catalogs = new Map();
      if (workspacePath && (!explicitKind || explicitKind === "git")) catalogs.set("git", [{ key: "git:changes", kind: "git", label: "Git changes", token: "git:changes", description: "只读摘要 / read-only summary" }]);
      const publish = () => {
        if (requestRevision.current !== revision) return;
        const liveValue = valueRef.current;
        const liveCursor = textareaRef.current?.selectionStart ?? liveValue.length;
        const liveQuery = extractWorkspaceMentionQuery(liveValue, liveCursor);
        if (
          !liveQuery ||
          liveQuery.start !== query.start ||
          liveQuery.query !== query.query
        ) {
          close();
          return;
        }
        const suggestions = rankMentionSuggestions(paths, [...catalogs.values()].flat(), liveQuery.query, 12);
        setState(previous => ({ query: liveQuery, suggestions,
          selectedIndex: Math.max(0, suggestions.findIndex(item => item.key === previous.suggestions[previous.selectedIndex]?.key)),
          loading: pending > 0 && !suggestions.length, truncated: Boolean(paths.truncated) }));
      };
      const load = (get, apply) => {
        pending++;
        void Promise.resolve().then(get).then(apply, () => {}).finally(() => { pending--; publish(); });
      };
      // Each source publishes independently. Explicit extension references
      // never scan files or wait for unrelated catalogs/workbench resources.
      for (const kind of ["skill", "mcp"]) if (!explicitKind || explicitKind === kind)
        load(() => buildExtensionMentionIndex(workspacePath, kind), items => catalogs.set(kind, items));
      if (!explicitKind) load(async () => {
        if (taskId && workspacePath && query.query && window.desktop?.workbench?.request) {
          const search = await window.desktop.workbench.request({ action: "search", taskId, workspacePath, query: query.query.replace(/:\d+(?:-\d+)?$/, "") }).catch(() => null);
          if (search?.entries) { const found = search.entries.map(entry => entry.path + (entry.type === "directory" ? "/" : "")); found.truncated = search.truncated; return found; }
        }
        const indexed = await buildWorkspaceFileIndex(workspacePath);
        if (query.query && !rankWorkspaceFiles(indexed, query.query).length) {
          workspaceFileIndexes.delete(workspacePath);
          return buildWorkspaceFileIndex(workspacePath);
        }
        return indexed;
      }, items => { paths = items; });
      if ((!explicitKind || ["browser", "terminal"].includes(explicitKind)) && taskId && window.desktop?.workbench?.request)
        load(() => window.desktop.workbench.request({ action: "list", taskId, workspacePath }), resources => catalogs.set("workbench",
          (resources || []).filter(item => ["browser", "terminal", "process"].includes(item.kind)).map(item => {
            const kind = item.kind === "browser" ? "browser" : "terminal";
            return { key: kind + ":" + item.id, kind, label: item.title || item.id, token: kind + ":" + item.id, description: "显式发送只读快照 / explicitly send read-only snapshot" };
          })));
      publish();
    }, 120);
    return () => { clearTimeout(timer); requestRevision.current += 1; };
  }, [value, workspacePath, taskId, cursorRevision, textareaRef, close]);

  useEffect(() => {
    close();
  }, [workspacePath, close]);

  useEffect(() => {
    const invalidate = () => { workspaceFileIndexes.delete(workspacePath); invalidateExtensionIndex(workspacePath); refreshCursor(); };
    window.addEventListener("focus", invalidate);
    const unsubscribe = window.desktop?.harness?.onEvent?.((event) => {
      if (["tool.completed", "run.completed", "skill.activated"].includes(event.type)) invalidate();
    });
    return () => { window.removeEventListener("focus", invalidate); unsubscribe?.(); };
  }, [workspacePath, refreshCursor]);

  const select = useCallback(
    (suggestion) => {
      const textarea = textareaRef.current;
      const liveValue = valueRef.current;
      const query =
        state.query ||
        extractWorkspaceMentionQuery(
          liveValue,
          textarea?.selectionStart ?? liveValue.length,
        );
      if (!query || !suggestion?.token) return false;
      const result = replaceWorkspaceMentionQuery(liveValue, query, suggestion.token);
      setValue(result.value);
      close();
      window.requestAnimationFrame(() => {
        const nextTextarea = textareaRef.current;
        if (!nextTextarea) return;
        nextTextarea.focus();
        nextTextarea.setSelectionRange(result.cursor, result.cursor);
      });
      return true;
    },
    [close, setValue, state.query, textareaRef],
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (isComposingKey(event)) return false;
      if (!state.query) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return true;
      }
      if (
        state.suggestions.length &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setState((current) => {
          const count = current.suggestions.length;
          return count
            ? {
                ...current,
                selectedIndex:
                  (current.selectedIndex + direction + count) % count,
              }
            : current;
        });
        return true;
      }
      if (
        state.suggestions.length &&
        (event.key === "Enter" || event.key === "Tab")
      ) {
        event.preventDefault();
        event.stopPropagation();
        select(
          state.suggestions[state.selectedIndex] || state.suggestions[0],
        );
        return true;
      }
      return false;
    },
    [close, select, state],
  );

  return {
    open: Boolean(state.query),
    state,
    close,
    select,
    handleKeyDown,
    refreshCursor,
    menu: state.query ? (
      <WorkspaceMentionMenu state={state} onSelect={select} />
    ) : null,
  };
}
