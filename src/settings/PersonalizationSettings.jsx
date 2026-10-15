import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ImagePlus, Moon, Pencil, Plus, Sparkles, Sun, Trash2, X } from 'lucide-react';
import { useI18n } from '../i18n.jsx';
import { Switch } from '../components/Controls.jsx';
import { PRESET_COLORS, validateTheme, themeDraft, themeTokens } from '../../shared/appearance.js';
import './personalization-settings.css';

function ThemePreview({ draft, image, active = false }) {
  return <div className={`theme-preview ${active ? 'is-preview' : ''}`} style={{ '--preview-bg': draft.colors.background, '--preview-panel': draft.colors.panel, '--preview-text': draft.colors.text, '--preview-accent': draft.colors.accent }} aria-hidden="true">
    <div className="theme-preview-bar"><i /><i /><i /></div><div className="theme-preview-body"><div className="theme-preview-nav"><b /><b /><b /></div><div className="theme-preview-chat" style={image ? { backgroundImage: `linear-gradient(${draft.colors.background}${Math.round((1 - draft.backgroundStrength) * 255).toString(16).padStart(2, '0')}, ${draft.colors.background}${Math.round((1 - draft.backgroundStrength) * 255).toString(16).padStart(2, '0')}), url("${image}")` } : undefined}><i /><span /><span /><b /><footer><i /><i /></footer></div></div>
  </div>;
}
const explanation = (message, tr) => {
  const cases = [
    ['THEME_LOW_CONTRAST', '正文与背景对比度不足，请调整正文或背景颜色。', 'Text contrast is too low. Adjust the text or background colors.'],
    ['THEME_BASE_MISMATCH', '背景明暗与所选预设不符，请更换基底或调整背景。', 'Background brightness does not match the selected base.'],
    ['THEME_IMAGE_SIZE', '图片需小于 8MB，且不超过 1600 万像素。', 'Images must be below 8MB and 16 million pixels.'],
    ['THEME_IMAGE_TYPE', '请选择有效的 PNG、JPEG 或 WebP 图片。', 'Select a valid PNG, JPEG or WebP image.'],
    ['THEME_IMAGE_MISSING', '背景图片暂不可用，配色仍可使用。', 'The background image is unavailable; colors still work.'],
    ['APPEARANCE_RECOVERED', '已恢复内置外观，原主题配置文件损坏。重新保存即可继续使用。', 'Built-in appearance was restored after a damaged configuration. Save again to continue.'],
    ['APPEARANCE_CHANGED', '主题列表已更新，请重新选择后保存。', 'Themes changed. Select the theme again before saving.'],
    ['THEME_LIMIT', '最多保留 40 个主题，请先删除不需要的主题。', 'You can keep up to 40 themes. Remove an unused theme first.'],
    ['THEME_IMAGE_LIMIT', '最多导入 32 张背景图片。', 'Up to 32 background images can be imported.'],
    ['THEME_INVALID_NAME', '请填写主题名称（最多 60 字）。', 'Enter a theme name (up to 60 characters).'],
    ['APPEARANCE_DISABLED', '请先开启自定义外观。', 'Enable custom appearance first.'],
  ];
  const entry = cases.find(([code]) => String(message).includes(code));
  return entry ? tr(entry[1], entry[2]) : tr('无法保存，请检查主题配置后重试。', 'Could not save. Check the theme configuration and retry.');
};

export function PersonalizationSettings({ appearance, theme, onCreateWithAgent }) {
  const { tr } = useI18n();
  const { state, selected, ready, busy, available, error, request, selectPreset } = appearance;
  const [editor, setEditor] = useState(null), [editorError, setEditorError] = useState(''), [image, setImage] = useState(null), [preview, setPreview] = useState(false), [confirmDelete, setConfirmDelete] = useState(null);
  const imageRevision = useRef(0);
  useEffect(() => {
    const revision = ++imageRevision.current; setImage(null);
    if (editor?.backgroundId) window.desktop?.appearance?.request({ action: 'readImage', id: editor.backgroundId }).then(value => { if (revision === imageRevision.current) setImage(value); }).catch(() => {});
    return () => { imageRevision.current++; };
  }, [editor?.backgroundId]);
  const run = async input => { try { return await request(input); } catch { return null; } };
  const edit = (item = null, copy = false) => { setEditor(item ? { ...themeDraft(item), id: copy ? null : item.id, name: copy ? `${item.name} ${tr('副本', 'copy')}`.slice(0, 60) : item.name } : { name: '', base: theme, colors: { ...PRESET_COLORS[theme] }, backgroundId: null, backgroundStrength: .12, id: null }); setEditorError(''); setPreview(false); };
  const update = changes => { setEditor(value => ({ ...value, ...changes })); setEditorError(''); setPreview(false); };
  const save = async () => {
    try {
      const draft = validateTheme(themeDraft(editor));
      const result = await request({ action: 'save', id: editor.id, theme: draft });
      const saved = editor.id ? result.themes.find(item => item.id === editor.id) : result.themes.at(-1);
      await request({ action: 'preferences', selectedId: saved.id });
      setEditor(null); setPreview(false);
    } catch (cause) { setEditorError(explanation(cause.message, tr)); }
  };
  return <div className="personalization-settings">
    <header><h3>{tr('个性化', 'Personalization')}</h3><p>{tr('选择外观，或设计属于你的 AporiaX。', 'Choose an appearance, or make AporiaX your own.')}</p></header>
    <div className="theme-presets" role="group" aria-label={tr('内置外观', 'Built-in appearance')}>
      {['light', 'dark'].map(base => <button type="button" key={base} disabled={!ready || busy} aria-pressed={!selected && theme === base} onClick={() => { selectPreset(base); setEditor(null); }}>
        <ThemePreview draft={{ colors: PRESET_COLORS[base] }} /><span>{base === 'light' ? <Sun size={15} /> : <Moon size={15} />}{base === 'light' ? tr('白天', 'Day') : tr('黑夜', 'Night')}{!selected && theme === base && <Check size={14} />}</span>
      </button>)}
    </div>
    <div className="personalization-toggle"><div><strong>{tr('自定义外观', 'Custom appearance')}<small>{tr('实验功能', 'Experimental')}</small></strong><p>{tr('开启后可保存配色主题和本地背景图片。', 'Save color themes and local backgrounds.')}</p></div>
      <Switch label={tr('开启自定义外观', 'Enable custom appearance')} checked={state.enabled} disabled={!ready || busy || !available} onChange={() => { setEditor(null); void run({ action: 'preferences', enabled: !state.enabled, base: theme }); }} />
    </div>
    {!available && <p className="personalization-note">{tr('自定义主题需在新版桌面应用中使用。', 'Custom themes require the updated desktop app.')}</p>}
    {error && <p role="alert" className="personalization-error">{explanation(error, tr)}</p>}
    {state.enabled && <>
      <div className="personalization-list-heading"><h4>{tr('我的主题', 'My themes')}</h4><div><button type="button" disabled={busy} onClick={() => edit()}><Plus size={14} />{tr('新建', 'New')}</button><button type="button" title={!onCreateWithAgent ? tr('先打开一个对话，再让 AI 设计主题', 'Open a conversation first to design a theme with AI') : undefined} disabled={busy || !onCreateWithAgent} onClick={onCreateWithAgent}><Sparkles size={14} />{tr('让 AI 设计', 'Design with AI')}</button></div></div>
      {!state.themes.length && !editor && <div className="personalization-empty"><p>{tr('从一个颜色开始，或告诉 AI 你想要的风格。', 'Start with a color, or tell AI the look you want.')}</p></div>}
      <div className="personalization-theme-list">{state.themes.map(item => <div className="personalization-theme-row" key={item.id}>
        <div className="personalization-theme-swatches" aria-hidden="true">{[item.colors.panel, item.colors.background, item.colors.accent].map((color, i) => <i key={i} style={{ background: color }} />)}</div>
        <div className="personalization-theme-name"><strong>{item.name}</strong><small>{item.base === 'dark' ? tr('黑夜', 'Night') : tr('白天', 'Day')}{item.source === 'ai' ? ' · AI' : ''}{item.backgroundId ? ` · ${tr('背景图片', 'Background')}` : ''}</small></div>
        <div className="personalization-theme-actions"><button type="button" disabled={busy} aria-label={tr('应用主题 {name}', 'Apply theme {name}', { name: item.name })} onClick={() => void run({ action: 'preferences', selectedId: item.id })}>{selected?.id === item.id ? <Check size={14} /> : tr('应用', 'Apply')}</button>
          <button type="button" disabled={busy} aria-label={tr('编辑主题 {name}', 'Edit theme {name}', { name: item.name })} onClick={() => edit(item)}><Pencil size={14} /></button><button type="button" disabled={busy} aria-label={tr('复制主题 {name}', 'Copy theme {name}', { name: item.name })} onClick={() => edit(item, true)}><Copy size={14} /></button><button type="button" disabled={busy} aria-label={tr('删除主题 {name}', 'Delete theme {name}', { name: item.name })} onClick={() => setConfirmDelete(item)}><Trash2 size={14} /></button>
        </div>
      </div>)}</div>
      {confirmDelete && <div className="personalization-delete"><p>{tr('删除“{name}”？', 'Delete “{name}”?', { name: confirmDelete.name })}</p><div><button type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>{tr('取消', 'Cancel')}</button><button type="button" disabled={busy} onClick={async () => { const result = await run({ action: 'delete', id: confirmDelete.id }); if (result) { setConfirmDelete(null); if (editor?.id === confirmDelete.id) setEditor(null); } }}>{tr('删除', 'Delete')}</button></div></div>}
      {editor && <section className="personalization-editor">
        <div className="personalization-list-heading"><h4>{editor.id ? tr('编辑主题', 'Edit theme') : tr('新建主题', 'New theme')}</h4><button type="button" aria-label={tr('关闭主题编辑', 'Close theme editor')} disabled={busy} onClick={() => setEditor(null)}><X size={14} /></button></div>
        <div className="personalization-editor-basic"><label>{tr('名称', 'Name')}<input aria-label={tr('主题名称', 'Theme name')} value={editor.name} maxLength={60} onChange={event => update({ name: event.target.value })} /></label><div><span>{tr('明暗基底', 'Base appearance')}</span><div className="personalization-base">{['light', 'dark'].map(base => <button type="button" aria-pressed={editor.base === base} key={base} onClick={() => update({ base, colors: { ...PRESET_COLORS[base], accent: editor.colors.accent } })}>{base === 'light' ? tr('白天', 'Day') : tr('黑夜', 'Night')}</button>)}</div></div>
          <label className="personalization-color-label" title={tr('用于按钮、强调色、周额度条与应用标志', 'Used for buttons, accents, weekly quota bars and the app mark')}>{tr('主色', 'Accent')}<input type="color" aria-label={tr('主题主色', 'Theme accent')} value={editor.colors.accent} onChange={event => update({ colors: { ...editor.colors, accent: event.target.value } })} /></label>
        </div>
        <ThemePreview draft={editor} image={image} active={preview} />
        <div className="personalization-background"><div><strong>{tr('背景图片', 'Background image')}</strong><small>{tr('保存在本机 · PNG / JPEG / WebP · 8MB 以内', 'Stored locally · PNG / JPEG / WebP · Up to 8MB')}</small></div><button type="button" disabled={busy} onClick={async () => { const result = await run({ action: 'importImage' }); if (result) update({ backgroundId: result.images.at(-1).id }); }}><ImagePlus size={14} />{tr('选择图片', 'Choose image')}</button></div>
        {state.images.length > 0 && <label className="personalization-image-choice">{tr('已导入图片', 'Imported images')}<select aria-label={tr('主题背景图片', 'Theme background image')} value={editor.backgroundId || ''} onChange={event => update({ backgroundId: event.target.value || null })}><option value="">{tr('无背景图片', 'No background')}</option>{state.images.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
        <details className="personalization-advanced"><summary>{tr('高级配色', 'Advanced colors')}</summary><div>{[['background', tr('工作区背景', 'Workspace background')], ['panel', tr('侧栏与顶栏', 'Sidebar and titlebar')], ['text', tr('正文颜色', 'Text color')]].map(([key, label]) => <label key={key}>{label}<input type="color" aria-label={label} value={editor.colors[key]} onChange={event => update({ colors: { ...editor.colors, [key]: event.target.value } })} /><code>{editor.colors[key]}</code></label>)}</div>
          <label>{tr('背景图强度', 'Background strength')}<input type="range" min="0" max="18" step="1" value={Math.round(editor.backgroundStrength * 100)} aria-label={tr('背景图强度', 'Background strength')} onChange={event => update({ backgroundStrength: Number(event.target.value) / 100 })} /><span>{Math.round(editor.backgroundStrength * 100)}%</span></label>
        </details>
        {editorError && <p role="alert" className="personalization-error">{editorError}</p>}
        {preview && <p className="personalization-note">{tr('预览已通过配色检查，保存并应用后生效。', 'Preview passed color validation. Save and apply to use it.')}</p>}
        <div className="personalization-editor-footer"><button type="button" disabled={busy} onClick={() => { try { const value = validateTheme(themeDraft(editor)); themeTokens(value); setPreview(true); setEditorError(''); } catch (cause) { setEditorError(explanation(cause.message, tr)); } }}>{tr('预览', 'Preview')}</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>{tr('取消', 'Cancel')}</button><button type="button" className="personalization-save" disabled={busy} onClick={save}>{tr('保存并应用', 'Save and apply')}</button></div>
      </section>}
      <button type="button" className="personalization-reset" disabled={busy} onClick={() => { setEditor(null); void run({ action: 'preferences', selectedId: null, enabled: false, base: theme }); }}>{tr('恢复默认外观', 'Restore default appearance')}</button>
    </>}
  </div>;
}
