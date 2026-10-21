import { isComposingKey } from "../../shared/mention-tokens.js";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
} from "react";
import { ArrowLeft, Box, ChevronRight, FileText, Folder, GitBranch, Globe, ImagePlus, Layers, LoaderCircle, Plus, Sparkles, Terminal, X } from "lucide-react";
import { ROLE_CREATION_COMMAND, ROLE_CREATION_SKILL } from '../../shared/role-creation-command.js';
import {
  extractWorkspaceMentionQuery,
  rankWorkspaceFiles,
  replaceWorkspaceMentionQuery,
} from "../agent-process-model.js";
import { useI18n } from "../i18n";
import "../agent-process-mentions.css";

const workspaceFileIndexes = new Map();
const extensionMentionIndexes = new Map();
const CATEGORIES = [
  { key: 'files', label: '文件与目录', en: 'Files & folders', description: '引用工作区内容', hint: 'Workspace content', icon: Folder },
  { key: 'skill', label: 'Skills', en: 'Skills', description: '工作方法与专业流程', hint: 'Workflows & expertise', icon: Sparkles },
  { key: 'mcp', label: 'MCP', en: 'MCP', description: '已配置的外部工具', hint: 'Configured external tools', icon: Box },
  { key: 'workbench', label: '工作台', en: 'Workbench', description: '浏览器、终端与 Git', hint: 'Browser, terminal & Git', icon: Layers },
];
const RESOURCES = [
  { key: 'browser', label: '浏览器', en: 'Browser', icon: Globe },
  { key: 'terminal', label: '终端', en: 'Terminal', icon: Terminal },
  { key: 'git', label: 'Git', en: 'Git', icon: GitBranch },
];
const ICONS = { skill: Sparkles, mcp: Box, file: FileText, browser: Globe, terminal: Terminal, git: GitBranch };
const explicitCategory = query => /^(skill|mcp|git|terminal|browser):/i.exec(query)?.[1].toLowerCase() || '';
const categoryRows = category => (category === 'workbench' ? RESOURCES : CATEGORIES).map(item => ({ ...item, key: `category:${item.key}`, category: item.key, kind: 'category' }));
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
      alias: skill.name === ROLE_CREATION_SKILL ? ROLE_CREATION_COMMAND : undefined,
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

function rankMentionSuggestions(paths, extensions, query, limit = 12, category = '') {
  const source = String(query || "").toLowerCase();
  const prefix = explicitCategory(source);
  const explicitKind = prefix || category;
  const needle = prefix ? source.slice(prefix.length + 1) : source;
  const extensionMatches = extensions
    .filter((item) => !explicitKind || item.kind === explicitKind)
    .filter((item) => !needle || `${item.label} ${item.token} ${item.description}`.toLowerCase().includes(needle))
    .slice(0, explicitKind ? limit : 4);
  if (explicitKind && explicitKind !== 'files') return extensionMatches;
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

function WorkspaceMentionMenu({ state, onSelect, onBack, onClose, category, id }) {
  const { tr } = useI18n();
  const current = [...CATEGORIES, ...RESOURCES].find(item => item.key === category);
  const manual = Boolean(state.query.manual);
  const rootPalette = manual && !category;
  useEffect(() => {
    document.getElementById(`${id}-${state.selectedIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, state.selectedIndex]);
  return (
    <div className={`aporiax-workspace-mention-host ${manual ? 'is-add-menu' : ''}`}>
      <div className={`aporiax-workspace-mention-menu ${state.suggestions[0]?.action ? 'has-attachment-actions' : ''}`} id={`${id}-popup`}>
        <div className={`aporiax-workspace-mention-title ${rootPalette ? 'is-palette-root' : ''}`}>
          <span>{category ? <button type="button" aria-label={tr('返回引用分类', 'Back to categories')} onMouseDown={event => event.preventDefault()} onClick={onBack}><ArrowLeft size={15} /></button> : <span className="mention-at">{state.query.manual ? <Plus size={17} /> : '@'}</span>}
            {current ? tr(current.label, current.en) : state.query.manual ? tr('添加内容', 'Add content') : tr('添加引用', 'Add a reference')}
          </span>
          <button type="button" aria-label={tr('关闭引用菜单', 'Close references')} onMouseDown={event => event.preventDefault()} onClick={onClose}><X size={14} /></button>
        </div>
        {state.loading ? (
          <div className="aporiax-workspace-mention-empty">
            <LoaderCircle className="spin" size={13} />
            {tr("正在加载…", "Loading…")}
          </div>
        ) : state.suggestions.length ? (
          <div className="aporiax-workspace-mention-results" id={id} role="listbox" aria-label={tr('引用选项', 'References')}>
            {state.suggestions.map((suggestion, index) => {
              const Icon = suggestion.icon || (suggestion.kind === 'file' && suggestion.token.endsWith('/') ? Folder : ICONS[suggestion.kind]) || FileText;
              return (
              <React.Fragment key={suggestion.key}>
              {suggestion.group && <div className="mention-group-label" role="presentation">{tr(suggestion.group, suggestion.groupEn)}</div>}
              <button
                id={`${id}-${index}`}
                className={`${index === state.selectedIndex ? 'active' : ''} ${['skill', 'mcp'].includes(suggestion.category || suggestion.kind) ? 'is-capability' : ''}`}
                type="button"
                role="option"
                aria-selected={index === state.selectedIndex}
                aria-disabled={suggestion.disabled || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(suggestion)}
              >
                <Icon size={16} />
                <span><strong>{suggestion.en ? tr(suggestion.label, suggestion.en) : suggestion.label}</strong>{suggestion.description ? <small>{suggestion.hint ? tr(suggestion.description, suggestion.hint) : suggestion.description}</small> : null}</span>
                {suggestion.kind === 'category' && <ChevronRight size={14} className="mention-next" />}
              </button>
              </React.Fragment>
            ); })}
          </div>
        ) : (
          <div className="aporiax-workspace-mention-empty">
            {state.error ? tr('暂时无法加载，请重新打开分类', 'Unable to load; reopen this category') : category ? tr('没有可用的匹配项', 'No matching items available') : tr('没有匹配项，试试其他关键词', 'No matches; try another keyword')}
          </div>
        )}
        {state.truncated && <div className="aporiax-workspace-mention-empty">{tr("结果已截断；可缩小路径或直接输入完整引用。", "Results truncated; narrow the path or type an exact reference.")}</div>}
        {!manual && <div className="aporiax-workspace-mention-footer">
          <span>↑↓ {tr("选择", "Select")}</span>
          <span>Enter / Tab {tr("确认", "Choose")}</span>
          <span>Esc {tr("关闭", "Close")}</span>
        </div>}
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
  onAddFiles,
  onAddImages,
  attachmentLoading = false,
  filesOnly = false,
}) {
  const [state, setState] = useState(EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [cursorRevision, setCursorRevision] = useState(0);
  const [category, setCategory] = useState('');
  const [picker, setPicker] = useState(null);
  const menuId = useId();
  const dismissed = useRef('');
  const requestRevision = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const close = useCallback(() => {
    requestRevision.current += 1;
    workspaceFileIndexes.delete(workspacePath);
    setPicker(null);
    setState(EMPTY_STATE);
  }, [workspacePath]);

  const refreshCursor = useCallback((event) => {
    // These keys move the menu selection, not the textarea caret. Re-querying
    // on keyup would reset the keyboard selection to the first row.
    if (event?.type === 'keyup' && ['ArrowUp', 'ArrowDown'].includes(event.key) && stateRef.current.query) return;
    setCursorRevision((revision) => revision + 1);
  }, []);

  const dismiss = useCallback(() => {
    const query = extractWorkspaceMentionQuery(valueRef.current, textareaRef.current?.selectionStart);
    dismissed.current = query ? `${query.start}:${query.query}` : '';
    setCategory('');
    close();
  }, [close, textareaRef]);

  const togglePicker = useCallback(() => {
    if (stateRef.current.query?.manual) { dismiss(); return; }
    const input = textareaRef.current;
    const text = valueRef.current;
    const cursor = input?.selectionStart ?? text.length;
    setCategory('');
    setPicker({ source: text, start: cursor, end: input?.selectionEnd ?? cursor, query: '', manual: true });
    input?.focus();
  }, [dismiss, textareaRef]);

  useEffect(() => {
    if (!state.query) return;
    const onPointerDown = event => {
      if (event.target === textareaRef.current || event.target.closest?.('[data-composer-add]') || document.getElementById(`${menuId}-popup`)?.contains(event.target)) return;
      dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [Boolean(state.query), dismiss, menuId, textareaRef]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    if (picker && picker.source !== value) setPicker(null);
    const query = picker?.source === value ? picker : extractWorkspaceMentionQuery(value, cursor);
    if (!query) {
      dismissed.current = '';
      setCategory('');
      close();
      return;
    }
    if (!query.manual && dismissed.current === `${query.start}:${query.query}`) { close(); return; }
    dismissed.current = '';

    const revision = requestRevision.current + 1;
    requestRevision.current = revision;
    const activeCategory = explicitCategory(query.query) || category;
    if ((!query.query && !activeCategory) || activeCategory === 'workbench') {
      let categories = categoryRows(activeCategory);
      const actions = query.manual && !activeCategory ? [
        { key: 'attach:file', action: 'file', kind: 'action', label: '添加电脑文件', en: 'Add files from computer', description: 'PDF、Office、文本与代码', hint: 'PDF, Office, text & code', group: '添加附件', groupEn: 'Attachments', icon: FileText, disabled: attachmentLoading },
        { key: 'attach:image', action: 'image', kind: 'action', label: '添加电脑图片', en: 'Add images from computer', description: '截图、设计稿和参考图', hint: 'Screenshots, designs & references', icon: ImagePlus },
      ] : [];
      if (actions.length) {
        categories = ['files', 'workbench', 'skill', 'mcp'].map(key => categories.find(item => item.category === key));
        Object.assign(categories[0], { group: '项目上下文', groupEn: 'Project context' });
        Object.assign(categories[2], { group: '能力与工具', groupEn: 'Capabilities & tools' });
      }
      setState({ query, suggestions: [...actions, ...categories.filter(item => !filesOnly || item.category === 'files')], selectedIndex: 0, loading: false });
      return;
    }
    if (filesOnly && activeCategory && activeCategory !== 'files') {
      setState({ query, suggestions: [], selectedIndex: 0, loading: false }); return;
    }
    setState({
      query,
      suggestions: [],
      selectedIndex: 0,
      loading: true,
    });

    const timer = setTimeout(() => {
      const explicitKind = activeCategory;
      let paths = [], pending = 0, error = false;
      const catalogs = new Map();
      if (!filesOnly && workspacePath && (!explicitKind || explicitKind === "git")) catalogs.set("git", [{ key: "git:changes", kind: "git", label: "Git changes", token: "git:changes", description: "只读摘要 / read-only summary" }]);
      const publish = () => {
        if (requestRevision.current !== revision) return;
        const liveValue = valueRef.current;
        const liveCursor = textareaRef.current?.selectionStart ?? liveValue.length;
        const liveQuery = picker?.source === liveValue ? picker : extractWorkspaceMentionQuery(liveValue, liveCursor);
        if (
          !liveQuery ||
          liveQuery.start !== query.start ||
          liveQuery.query !== query.query
        ) {
          close();
          return;
        }
        const suggestions = rankMentionSuggestions(paths, [...catalogs.values()].flat(), liveQuery.query, 30, activeCategory);
        setState(previous => ({ query: liveQuery, suggestions,
          selectedIndex: Math.max(0, suggestions.findIndex(item => item.key === previous.suggestions[previous.selectedIndex]?.key)),
          loading: pending > 0 && !suggestions.length, truncated: Boolean(paths.truncated), error }));
      };
      const load = (get, apply) => {
        pending++;
        void Promise.resolve().then(get).then(apply, () => { error = true; }).finally(() => { pending--; publish(); });
      };
      // Each source publishes independently. Explicit extension references
      // never scan files or wait for unrelated catalogs/workbench resources.
      for (const kind of ["skill", "mcp"]) if (!filesOnly && (!explicitKind || explicitKind === kind))
        load(() => buildExtensionMentionIndex(workspacePath, kind), items => catalogs.set(kind, items));
      if (!explicitKind || explicitKind === 'files') load(async () => {
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
      if (!filesOnly && (!explicitKind || ["browser", "terminal"].includes(explicitKind)) && taskId && window.desktop?.workbench?.request)
        load(() => window.desktop.workbench.request({ action: "list", taskId, workspacePath }), resources => catalogs.set("workbench",
          (resources || []).filter(item => ["browser", "terminal", "process"].includes(item.kind)).map(item => {
            const kind = item.kind === "browser" ? "browser" : "terminal";
            return { key: kind + ":" + item.id, kind, label: item.title || item.id, token: kind + ":" + item.id, description: "显式发送只读快照 / explicitly send read-only snapshot" };
          })));
      publish();
    }, 120);
    return () => { clearTimeout(timer); requestRevision.current += 1; };
  }, [value, workspacePath, taskId, cursorRevision, textareaRef, close, category, picker, attachmentLoading, filesOnly]);

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
      if (suggestion?.disabled) return true;
      if (suggestion?.action) {
        if (suggestion.action === 'file' && attachmentLoading) return true;
        dismiss();
        // Invoke synchronously inside the user gesture so the native picker opens.
        if (suggestion.action === 'file') onAddFiles?.();
        else onAddImages?.();
        return true;
      }
      if (suggestion?.category) { setCategory(suggestion.category); return true; }
      const textarea = textareaRef.current;
      const liveValue = valueRef.current;
      const query =
        state.query ||
        extractWorkspaceMentionQuery(
          liveValue,
          textarea?.selectionStart ?? liveValue.length,
        );
      if (!query || !suggestion?.token) return false;
      const prefix = query.manual && query.start > 0 && !/[\s（(【\[,，。!?！？;；]$/u.test(liveValue.slice(0, query.start)) ? ' ' : '';
      const tokenResult = suggestion.alias
        ? { value: `${suggestion.alias} ` } : replaceWorkspaceMentionQuery('', { start: 0, end: 0 }, suggestion.token);
      const inserted = prefix + tokenResult.value;
      const result = { value: `${liveValue.slice(0, query.start)}${inserted}${liveValue.slice(query.end)}`, cursor: query.start + inserted.length };
      setValue(result.value);
      setCategory('');
      close();
      window.requestAnimationFrame(() => {
        const nextTextarea = textareaRef.current;
        if (!nextTextarea || valueRef.current !== result.value) return;
        nextTextarea.focus();
        nextTextarea.setSelectionRange(result.cursor, result.cursor);
      });
      return true;
    },
    [close, dismiss, onAddFiles, onAddImages, attachmentLoading, setValue, state.query, textareaRef],
  );

  const back = useCallback(() => {
    const active = explicitCategory(state.query?.query) || category;
    if (explicitCategory(state.query?.query)) {
      const query = state.query;
      setValue(`${valueRef.current.slice(0, query.start)}@${valueRef.current.slice(query.end)}`);
      requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(query.start + 1, query.start + 1); });
    }
    setCategory(RESOURCES.some(item => item.key === active) ? 'workbench' : '');
  }, [category, state.query, setValue, textareaRef]);

  const handleKeyDown = useCallback(
    (event) => {
      if (isComposingKey(event)) return false;
      if (!state.query) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return true;
      }
      if (event.key === 'ArrowLeft' && category && !state.query.query) { event.preventDefault(); back(); return true; }
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
        (event.key === "Enter" || event.key === "Tab" || (event.key === 'ArrowRight' && state.suggestions[state.selectedIndex]?.category))
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
    [dismiss, select, state, category, back],
  );

  return {
    open: Boolean(state.query),
    state,
    close,
    togglePicker,
    select,
    handleKeyDown,
    refreshCursor,
    inputProps: { 'aria-autocomplete': 'list', 'aria-controls': state.query && state.suggestions.length ? menuId : undefined, 'aria-activedescendant': state.query && state.suggestions.length ? `${menuId}-${state.selectedIndex}` : undefined },
    menu: state.query ? (
      <WorkspaceMentionMenu state={state} onSelect={select} onBack={back} onClose={dismiss} category={explicitCategory(state.query.query) || category} id={menuId} />
    ) : null,
  };
}
