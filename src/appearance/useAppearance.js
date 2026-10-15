import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultAppearance, validateAppearance, themeTokens } from '../../shared/appearance.js';
import './appearance.css';

export function useAppearance(theme, setTheme) {
  const api = window.desktop?.appearance;
  const [state, setState] = useState(defaultAppearance), [ready, setReady] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [background, setBackground] = useState(null);
  const stateRef = useRef(state), baseRef = useRef(theme), writing = useRef(false);
  baseRef.current = theme;
  const accept = useCallback(value => {
    const { error: recovered, ...record } = value;
    const next = validateAppearance(record);
    if (next.revision < stateRef.current.revision) return;
    stateRef.current = next; setState(next); setError(recovered || '');
    if (next.base) setTheme(next.base);
  }, [setTheme]);
  useEffect(() => {
    let active = true;
    if (!api?.request) { setReady(true); return; }
    api.request({ action: 'get' }).then(value => { if (active) accept(value); }).catch(() => { if (active) setError('APPEARANCE_LOAD_FAILED'); }).finally(() => { if (active) setReady(true); });
    const off = api.subscribe?.(value => { if (active) { try { accept(value); } catch { setError('APPEARANCE_LOAD_FAILED'); } } });
    return () => { active = false; off?.(); };
  }, [api, accept]);
  const selected = state.enabled ? state.themes.find(item => item.id === state.selectedId) : null;
  const imageId = selected?.backgroundId;
  useEffect(() => {
    let active = true; setBackground(null);
    if (imageId && api?.request) api.request({ action: 'readImage', id: imageId }).then(value => {
      if (active && typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) setBackground({ id: imageId, value });
    }).catch(() => { if (active) setError('THEME_IMAGE_MISSING'); });
    return () => { active = false; };
  }, [imageId, api]);
  useEffect(() => {
    const root = document.documentElement, tokens = selected ? themeTokens(selected) : {};
    root.dataset.customTheme = selected ? selected.id : '';
    for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
    const url = background && background.id === imageId ? background.value : null;
    root.dataset.themeBackground = url ? 'true' : '';
    if (url) { root.style.setProperty('--theme-background-image', `url("${url}")`); root.style.setProperty('--theme-background-strength', selected.backgroundStrength); }
    // Keep native caption buttons on the same validated colors as the renderer.
    void window.desktop?.theme?.set(selected ? { base: selected.base, colors: selected.colors } : theme).catch?.(() => {});
    return () => {
      for (const key of Object.keys(tokens)) root.style.removeProperty(key);
      root.style.removeProperty('--theme-background-image'); root.style.removeProperty('--theme-background-strength');
      delete root.dataset.customTheme; delete root.dataset.themeBackground;
    };
  }, [selected, background, imageId, theme]);
  const request = useCallback(async input => {
    if (!api?.request) throw Error('APPEARANCE_UNAVAILABLE');
    if (writing.current) throw Error('APPEARANCE_BUSY');
    writing.current = true; setBusy(true); setError('');
    try {
      const result = await api.request({ ...input, ...(!['importImage', 'get', 'readImage'].includes(input.action) ? { revision: stateRef.current.revision } : {}) });
      if (result) accept(result);
      return result;
    } catch (cause) {
      setError(String(cause.message || 'APPEARANCE_SAVE_FAILED'));
      if (String(cause.message).includes('APPEARANCE_CHANGED')) { try { accept(await api.request({ action: 'get' })); } catch { /* preserve last good snapshot */ } }
      throw cause;
    } finally { writing.current = false; setBusy(false); }
  }, [api, accept]);
  const selectPreset = useCallback(base => {
    if (!api?.request) { setTheme(base); return; }
    void request({ action: 'preferences', selectedId: null, base }).catch(() => {});
  }, [api, request, setTheme]);
  return { state, ready, busy, error, setError, selected, available: Boolean(api?.request), request, selectPreset,
    toggle: () => selectPreset(baseRef.current === 'dark' ? 'light' : 'dark') };
}
