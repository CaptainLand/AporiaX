import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { ModelChoice, SegmentedControl } from '../components/Controls.jsx';
import { getModel, getModelGroups } from './model-catalog.js';
import { ModelSetupActions } from './ModelSetupActions.jsx';
import { isComposingKey } from '../../shared/mention-tokens.js';
import { modelSelectionPatch, reasoningState } from './reasoning-state.js';
import { EffortGem } from './EffortGem.jsx';

const EFFORT_INSET = 15; // 26px thumb plus a 2px end clearance.
const THUMB_OFFSET = 2; // Cover the fill's rounded end; keep pointer math in sync.

/** Shared chooser UI. Callers retain ownership of selection and reasoning state.
 * Side chat intentionally omits controls its existing send contract cannot use.
 */
export function ModelMenu({ task, providers, onUpdate, onClose, onManageProviders,
  showReasoning = true, boundaryRef, id, className = '', optionsRole = false, label, mode = 'models' } = {}) {
  const { tr } = useI18n();
  const effortOnly = mode === 'effort';
  const menuRef = useRef(null), searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState({});
  const [dragProgress, setDragProgress] = useState(null);
  const activePointer = useRef(null);
  const dragBounds = useRef(null), dragFrame = useRef(0), pendingProgress = useRef(null);
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);
  const selectedModel = useMemo(() => getModel(providers, task.providerId, task.modelId), [providers, task.providerId, task.modelId]);
  const reasoning = reasoningState(selectedModel, task);
  const modelGroups = useMemo(() => getModelGroups(providers), [providers]);
  const showSearch = modelGroups.reduce((total, group) => total + group.models.length, 0) >= 8;
  const effortIndex = Math.max(0, reasoning.efforts.indexOf(reasoning.effort));
  const effortProgress = reasoning.efforts.length > 1 ? effortIndex / (reasoning.efforts.length - 1) * 100 : 0;
  const visualProgress = dragProgress ?? effortProgress;
  const previewIndex = Math.round(visualProgress / 100 * (reasoning.efforts.length - 1));
  const previewEffort = reasoning.efforts[previewIndex];
  const pointerProgress = event => {
    const bounds = dragBounds.current || event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(100, (event.clientX - bounds.left - EFFORT_INSET - THUMB_OFFSET) / Math.max(1, bounds.width - EFFORT_INSET * 2) * 100));
  };
  const updateEffort = effort => {
    // Releasing on the current stop must not rerender/persist the whole task.
    if (effort !== reasoning.effort) onUpdate({ effort });
  };
  const startDrag = event => {
    if (event.button !== 0 || !event.isPrimary || reasoning.efforts.length < 2) return;
    event.preventDefault();
    dragBounds.current = event.currentTarget.getBoundingClientRect();
    activePointer.current = event.pointerId;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragProgress(pointerProgress(event));
  };
  const moveDrag = event => {
    if (activePointer.current !== event.pointerId) return;
    pendingProgress.current = pointerProgress(event);
    if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      setDragProgress(pendingProgress.current);
    });
  };
  const clearDrag = () => {
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
    activePointer.current = null;
    dragBounds.current = null;
    setDragProgress(null);
  };
  const finishDrag = (event, commit) => {
    if (activePointer.current !== event.pointerId) return;
    const progress = pointerProgress(event);
    clearDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit) updateEffort(reasoning.efforts[Math.round(progress / 100 * (reasoning.efforts.length - 1))]);
  };
  const effortLabel = value => value === 'xhigh' ? 'XHigh' : value[0].toUpperCase() + value.slice(1);
  const filtered = useMemo(() => {
    const value = showSearch ? query.trim().toLocaleLowerCase() : '';
    return modelGroups.map(group => ({ ...group, models: group.models.filter(model =>
      [model.name, model.shortName, model.id, model.providerName].join(' ').toLocaleLowerCase().includes(value)) })).filter(group => group.models.length);
  }, [modelGroups, query, showSearch]);
  const boundary = () => boundaryRef?.current || menuRef.current?.closest('.model-control') || menuRef.current;
  const close = (restoreFocus = false) => {
    const trigger = boundary()?.querySelector(effortOnly ? 'button.effort-trigger' : 'button.model-trigger');
    onClose();
    if (restoreFocus) trigger?.focus();
  };
  useEffect(() => {
    if (effortOnly) menuRef.current?.querySelector('input[type="range"]')?.focus();
    else if (showSearch) searchRef.current?.focus();
    else (menuRef.current?.querySelector('.model-choice.selected:not(:disabled)') || menuRef.current?.querySelector('.model-choice:not(:disabled)') || menuRef.current)?.focus();
  }, [effortOnly, showSearch]);
  useEffect(() => {
    const outside = event => { if (!boundary()?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [onClose, boundaryRef]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const composer = menu?.closest('.composer, .side-chat-composer');
    const pane = menu?.closest('.side-chat, .thread');
    const position = () => {
      const parent = menu?.offsetParent;
      if (!composer || !pane || !parent) return;
      const form = composer.getBoundingClientRect(), area = pane.getBoundingClientRect(), origin = parent.getBoundingClientRect();
      const trigger = boundary()?.getBoundingClientRect() || origin;
      const width = Math.min(effortOnly ? 260 : 285, Math.max(180, area.width - 24));
      const left = Math.max(area.left + 10, Math.min(trigger.left, area.right - width - 10));
      setPlacement({ width, left: left - origin.left, bottom: origin.bottom - form.top + 10,
        maxHeight: Math.max(80, Math.min(620, form.top - Math.max(0, area.top) - 20)) });
    };
    position();
    const observer = new ResizeObserver(position);
    if (pane) observer.observe(pane);
    if (composer) observer.observe(composer);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [boundaryRef, effortOnly]);
  const choose = selection => onUpdate(modelSelectionPatch(selection, task));
  const navigate = event => {
    if (isComposingKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (effortOnly) return; // Preserve native range keyboard navigation.
    if (event.target.closest('.model-menu-row, .model-setup')) return;
    const rows = [...(menuRef.current?.querySelectorAll('.model-choice:not(:disabled)') || [])];
    const index = rows.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    } else if (event.key === 'Enter' && event.target === searchRef.current) {
      event.preventDefault();
      const first = filtered.flatMap(group => group.models).find(model => !model.disabled);
      if (first) choose(first);
    }
  };
  return <div className={`model-menu ${effortOnly ? 'model-effort-menu' : ''} ${className}`.trim()} ref={menuRef} id={id} role="dialog" tabIndex={-1}
    aria-label={label || (effortOnly ? tr('思考强度', 'Reasoning effort') : tr('选择模型', 'Choose a model'))} style={placement} onKeyDown={navigate}>
    {effortOnly ? <div className="effort-slider-card">
      <div className="effort-slider-header">
        <strong>{effortLabel(previewEffort)}</strong>
      </div>
      <div className="effort-slider-control" data-dragging={dragProgress !== null} style={{ '--effort-inset': `${EFFORT_INSET}px`, '--effort-thumb-offset': `${THUMB_OFFSET}px` }}>
        <div className="effort-slider-visual" aria-hidden="true">
          <span className="effort-slider-track">
            <span className="effort-slider-fill" style={{ width: `calc(${visualProgress}% + ${EFFORT_INSET * 2 * (1 - visualProgress / 100)}px)` }} />
            <span className="effort-slider-gem-mask" style={{ clipPath: `inset(0 calc(${100 - visualProgress}% - ${EFFORT_INSET * 2 * (1 - visualProgress / 100)}px) 0 0 round 11px)` }}>
              <EffortGem speed={visualProgress >= 100 ? 3 : 1} />
            </span>
          </span>
          <span className="effort-slider-thumb" style={{ left: `${visualProgress}%` }} />
        </div>
        <input type="range" min="0" max={Math.max(0, reasoning.efforts.length - 1)} step="1" value={previewIndex}
          disabled={reasoning.efforts.length < 2} aria-label={tr('思考强度', 'Reasoning effort')} aria-valuetext={effortLabel(previewEffort)}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={event => finishDrag(event, true)} onPointerCancel={event => finishDrag(event, false)}
          onLostPointerCapture={event => { if (activePointer.current === event.pointerId) clearDrag(); }}
          onChange={event => { if (activePointer.current === null) updateEffort(reasoning.efforts[Number(event.target.value)]); }} />
      </div>
      <div className="effort-slider-labels" aria-hidden="true">{reasoning.efforts.map(value => <span key={value} data-active={value === previewEffort}>{effortLabel(value)}</span>)}</div>
    </div> : <>
    {showSearch && <><div className="model-menu-topbar">
      <div className="model-menu-heading">{tr('选择模型', 'Choose a model')}</div>
      <button type="button" className="icon-button" aria-label={tr('关闭模型选择', 'Close model picker')} onClick={() => close(true)}><X size={15} /></button>
    </div>
    <div className="model-menu-search"><Search size={15} aria-hidden="true" />
      <input ref={searchRef} aria-label={tr('搜索模型', 'Search models')} placeholder={tr('搜索模型或 Provider…', 'Search models or providers…')}
        value={query} onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" className="icon-button" aria-label={tr('清空模型搜索', 'Clear model search')} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={14} /></button>}
    </div></>}
    <div className="model-menu-options" role={optionsRole ? 'listbox' : undefined} aria-label={optionsRole ? tr('可用模型', 'Available models') : undefined}>
      {filtered.map(group => <div className="model-menu-source-group" key={group.source} data-source={group.source} role={optionsRole ? 'group' : undefined} aria-label={optionsRole ? tr(group.titleZh, group.titleEn) : undefined}>
        <div className="model-menu-heading">{tr(group.titleZh, group.titleEn)}</div>
        <div className="model-menu-source-note">{tr(group.noteZh, group.noteEn)}</div>
        {group.models.map(model => <ModelChoice key={`${model.providerId}:${model.id}`} compact option={optionsRole} model={model} hideDescription={group.source === 'user-provider'}
          selected={task.providerId === model.providerId && task.modelId === model.id} onSelect={choose} />)}
      </div>)}
      {!filtered.length && <p className="model-menu-empty">{tr('没有匹配的模型', 'No matching models')}</p>}
    </div>
    <ModelSetupActions compact onManageProviders={onManageProviders} />
    {showReasoning && reasoning.thinking && selectedModel.id && !selectedModel.disabled &&
      <div className="model-menu-row model-menu-effort">
        <span className="model-menu-label">{tr('思考强度', 'Reasoning effort')}</span>
        <SegmentedControl value={reasoning.effort} ariaLabel={tr('思考强度', 'Reasoning effort')}
          options={reasoning.efforts.map(value => ({ value, label: value === 'xhigh' ? 'XHigh' : value[0].toUpperCase() + value.slice(1) }))}
          onChange={effort => onUpdate({ effort })} />
      </div>}
    </>}
  </div>;
}
