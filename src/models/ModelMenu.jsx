import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { ModelChoice, SegmentedControl, Switch } from '../components/Controls.jsx';
import { getModel, getModelGroups } from './model-catalog.js';
import { ModelSetupActions } from './ModelSetupActions.jsx';
import { isComposingKey } from '../../shared/mention-tokens.js';

/** Shared chooser UI. Callers retain ownership of selection and reasoning state.
 * Side chat intentionally omits controls its existing send contract cannot use.
 */
export function ModelMenu({ task, providers, onUpdate, onClose, onManageProviders,
  showReasoning = true, boundaryRef, id, className = '', optionsRole = false, label } = {}) {
  const { tr } = useI18n();
  const menuRef = useRef(null), searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState({});
  const selectedModel = getModel(providers, task.providerId, task.modelId);
  const modelGroups = useMemo(() => getModelGroups(providers), [providers]);
  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return modelGroups.map(group => ({ ...group, models: group.models.filter(model =>
      [model.name, model.shortName, model.id, model.providerName].join(' ').toLocaleLowerCase().includes(value)) })).filter(group => group.models.length);
  }, [modelGroups, query]);
  const boundary = () => boundaryRef?.current || menuRef.current?.closest('.model-control') || menuRef.current;
  const close = (restoreFocus = false) => {
    const trigger = boundary()?.querySelector('button.model-trigger');
    onClose();
    if (restoreFocus) trigger?.focus();
  };
  useEffect(() => { searchRef.current?.focus(); }, []);
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
      const width = Math.min(285, Math.max(180, area.width - 24));
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
  }, [boundaryRef]);
  const choose = selection => onUpdate({
    providerId: selection.providerId, modelId: selection.id,
    thinking: selection.supportsThinking ? selection.thinkingAlwaysOn || task.thinking : false,
    ...(selection.defaultEffort && (selection.id !== task.modelId || selection.providerId !== task.providerId)
      ? { effort: selection.defaultEffort } : {}),
  });
  const navigate = event => {
    if (isComposingKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
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
  return <div className={`model-menu ${className}`.trim()} ref={menuRef} id={id} role="dialog"
    aria-label={label || tr('选择模型', 'Choose a model')} style={placement} onKeyDown={navigate}>
    <div className="model-menu-heading">{tr('选择模型', 'Choose a model')}</div>
    <div className="model-menu-search"><Search size={15} aria-hidden="true" />
      <input ref={searchRef} aria-label={tr('搜索模型', 'Search models')} placeholder={tr('搜索模型或 Provider…', 'Search models or providers…')}
        value={query} onChange={event => setQuery(event.target.value)} />
      <button type="button" className="icon-button" aria-label={tr('关闭模型选择', 'Close model picker')} onClick={() => close(true)}><X size={15} /></button>
    </div>
    <div className="model-menu-options" role={optionsRole ? 'listbox' : undefined} aria-label={optionsRole ? tr('可用模型', 'Available models') : undefined}>
      {filtered.map((group, index) => <div className="model-menu-source-group" key={group.source} role={optionsRole ? 'group' : undefined} aria-label={optionsRole ? tr(group.titleZh, group.titleEn) : undefined}>
        {index > 0 && <div className="model-menu-divider" />}
        <div className="model-menu-heading">{tr(group.titleZh, group.titleEn)}</div>
        <div className="model-menu-source-note">{tr(group.noteZh, group.noteEn)}</div>
        {group.models.map(model => <ModelChoice key={`${model.providerId}:${model.id}`} compact option={optionsRole} model={model}
          selected={task.providerId === model.providerId && task.modelId === model.id} onSelect={choose} />)}
      </div>)}
      {!filtered.length && <p className="model-menu-empty">{tr('没有匹配的模型', 'No matching models')}</p>}
    </div>
    <ModelSetupActions onManageProviders={onManageProviders} />
    {showReasoning && <>
      <div className="model-menu-divider" />
      <div className="model-menu-row"><div><span className="model-menu-label">{tr('深度思考', 'Deep thinking')}</span>
        <small>{selectedModel.thinkingAlwaysOn ? tr('自适应思考始终开启，可调整强度', 'Adaptive thinking is always on; choose its effort') : tr('先规划再执行', 'Plan before acting')}</small></div>
        <Switch checked={selectedModel.thinkingAlwaysOn || task.thinking} label={tr('深度思考', 'Deep thinking')}
          disabled={!selectedModel.id || selectedModel.disabled || !selectedModel.supportsThinking || selectedModel.thinkingAlwaysOn}
          onChange={thinking => onUpdate({ thinking })} />
      </div>
      {(task.thinking || selectedModel.thinkingAlwaysOn) && <div className={`model-menu-row${selectedModel.supportedEfforts ? ' model-menu-effort' : ''}`}>
        <span className="model-menu-label">{tr('思考强度', 'Reasoning effort')}</span>
        <SegmentedControl value={task.effort || selectedModel.defaultEffort} ariaLabel={tr('思考强度', 'Reasoning effort')}
          options={selectedModel.supportedEfforts ? selectedModel.supportedEfforts.map(value => ({ value, label: value === 'xhigh' ? 'XHigh' : value[0].toUpperCase() + value.slice(1) }))
            : [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }]}
          onChange={effort => onUpdate({ effort })} />
      </div>}
    </>}
  </div>;
}
