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
  if (workspaceFileIndexes.has(workspacePath)) {
    return workspaceFileIndexes.get(workspacePath);
  }

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
          queue.push(entry.path);
        }
      }
    }
    return [...new Set(files)].filter(Boolean);
  })();

  workspaceFileIndexes.set(workspacePath, promise);
  try {
    return await promise;
  } catch (error) {
    workspaceFileIndexes.delete(workspacePath);
    throw error;
  }
}

async function buildExtensionMentionIndex(workspacePath) {
  const cached = extensionMentionIndexes.get(workspacePath);
  if (cached && Date.now() - cached.createdAt < 10_000) return cached.promise;
  const promise = Promise.all([
    window.desktop?.core?.skills?.({ workspacePath }) || Promise.resolve({ skills: [] }),
    window.desktop?.core?.mcp?.({ workspacePath }) || Promise.resolve({ servers: [] }),
  ]).then(([skills, mcp]) => [
    ...(skills?.skills || []).map((skill) => ({
      key: `skill:${skill.name}`,
      kind: "skill",
      label: skill.title || skill.name,
      token: `skill:${skill.name}`,
      description: skill.description || skill.source || "Skill",
    })),
    ...(mcp?.servers || []).map((server) => ({
      key: `mcp:${server.id}`,
      kind: "mcp",
      label: server.name || server.id,
      token: `mcp:${server.id}`,
      description: `${server.id} · ${server.transport}`,
    })),
  ]);
  extensionMentionIndexes.set(workspacePath, { createdAt: Date.now(), promise });
  return promise;
}

function rankMentionSuggestions(paths, extensions, query, limit = 12) {
  const source = String(query || "").toLowerCase();
  const explicitKind = source.startsWith("skill:")
    ? "skill"
    : source.startsWith("mcp:") ? "mcp" : "";
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
            {tr("引用文件、Skill 或 MCP", "Mention a file, Skill, or MCP")}
          </span>
          <small>
            {tr("输入 @skill: 或 @mcp: 可直接筛选", "Type @skill: or @mcp: to filter")}
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
}) {
  const [state, setState] = useState(EMPTY_STATE);
  const [cursorRevision, setCursorRevision] = useState(0);
  const requestRevision = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const close = useCallback(() => {
    requestRevision.current += 1;
    setState(EMPTY_STATE);
  }, []);

  const refreshCursor = useCallback(() => {
    setCursorRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const query = extractWorkspaceMentionQuery(value, cursor);
    if (!query || !workspacePath) {
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

    void Promise.all([
      buildWorkspaceFileIndex(workspacePath),
      buildExtensionMentionIndex(workspacePath),
    ])
      .then(([paths, extensions]) => {
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
        setState({
          query: liveQuery,
          suggestions: rankMentionSuggestions(paths, extensions, liveQuery.query, 12),
          selectedIndex: 0,
          loading: false,
        });
      })
      .catch(() => {
        if (requestRevision.current !== revision) return;
        setState({
          query,
          suggestions: [],
          selectedIndex: 0,
          loading: false,
        });
      });
  }, [value, workspacePath, cursorRevision, textareaRef, close]);

  useEffect(() => {
    close();
  }, [workspacePath, close]);

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
