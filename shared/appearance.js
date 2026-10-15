export const THEME_SKILL = 'create-aporiax-theme';
export const THEME_COMMAND = '@skill:create-aporiax-theme';
export const IMAGE_ID = /^bg-[a-f0-9-]{36}$/;
export const THEME_ID = /^theme-[a-f0-9-]{36}$/;
export const PRESET_COLORS = Object.freeze({
  light: { accent: '#1a7acb', background: '#ffffff', panel: '#f3f4f6', text: '#25282d' },
  dark: { accent: '#398ad6', background: '#0f1114', panel: '#14161a', text: '#eaedf2' },
});
const rgb = color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
const hex = channels => '#' + channels.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
export function mixColor(a, b, weight) { return hex(rgb(a).map((value, i) => value * (1 - weight) + rgb(b)[i] * weight)); }
const luminance = color => rgb(color).map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export function validateTheme(input) {
  if (!only(input, ['name', 'base', 'colors', 'backgroundId', 'backgroundStrength'])) throw Error('THEME_INVALID_FIELDS');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) throw Error('THEME_INVALID_NAME');
  if (!['light', 'dark'].includes(input.base)) throw Error('THEME_INVALID_BASE');
  if (!only(input.colors, ['accent', 'background', 'panel', 'text'])) throw Error('THEME_INVALID_COLORS');
  const colors = {};
  for (const key of ['accent', 'background', 'panel', 'text']) {
    if (typeof input.colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.colors[key])) throw Error('THEME_INVALID_COLORS');
    colors[key] = input.colors[key].toLowerCase();
  }
  const light = input.base === 'light';
  if (light ? luminance(colors.background) < .5 || luminance(colors.panel) < .4 : luminance(colors.background) > .12 || luminance(colors.panel) > .16) throw Error('THEME_BASE_MISMATCH');
  if (contrast(colors.text, colors.background) < 7 || contrast(colors.text, colors.panel) < 7) throw Error('THEME_LOW_CONTRAST');
  if (input.backgroundId != null && !IMAGE_ID.test(input.backgroundId)) throw Error('THEME_INVALID_IMAGE');
  const backgroundStrength = input.backgroundStrength ?? .12;
  if (typeof backgroundStrength !== 'number' || !Number.isFinite(backgroundStrength) || backgroundStrength < 0 || backgroundStrength > .18) throw Error('THEME_INVALID_STRENGTH');
  if (input.backgroundId && contrast(colors.text, mixColor(colors.background, light ? '#000000' : '#ffffff', backgroundStrength)) < 4.5) throw Error('THEME_LOW_CONTRAST');
  return { name: input.name.trim(), base: input.base, colors, backgroundId: input.backgroundId || null, backgroundStrength };
}
function readableColor(color, background, ratio = 4.5, panel = background) {
  const readable = candidate => contrast(candidate, background) >= ratio && contrast(candidate, panel) >= ratio;
  if (readable(color)) return color;
  const target = luminance(background) > .3 ? '#000000' : '#ffffff';
  for (let step = .05; step <= 1.001; step += .05) { const candidate = mixColor(color, target, Math.min(1, step)); if (readable(candidate)) return candidate; }
  return target;
}
export function themeTokens(theme) {
  const { background: bg, panel, text, accent } = theme.colors;
  const tokens = {};
  const ramp = [bg, panel, mixColor(panel, text, .025), mixColor(panel, text, .055), mixColor(panel, text, .08), mixColor(panel, text, .12), mixColor(panel, text, .18), mixColor(panel, text, .26), mixColor(bg, text, .5), readableColor(mixColor(bg, text, .65), bg, 4.5, panel), readableColor(mixColor(bg, text, .78), bg, 4.5, panel), text];
  ramp.forEach((color, index) => tokens[`--gray-${index + 1}`] = color);
  for (let index = 1; index <= 8; index++) tokens[`--accent-${index}`] = mixColor(bg, accent, [0, .04, .08, .12, .17, .23, .33, .5][index - 1]);
  tokens['--accent-9'] = accent; tokens['--accent-10'] = mixColor(accent, text, .12);
  tokens['--accent-11'] = readableColor(accent, bg, 4.5, panel); tokens['--accent-12'] = readableColor(mixColor(accent, text, .4), bg, 7, panel);
  tokens['--bg-navigation'] = panel; tokens['--border'] = tokens['--gray-6'];
  tokens['--theme-accent-contrast'] = readableColor('#ffffff', accent);
  tokens['--theme-quota-gradient'] = `linear-gradient(90deg, ${mixColor(accent, text, .2)}, ${accent} 58%, ${mixColor(accent, text, .38)})`;
  (theme.base === 'dark' ? [.25, .45, .7, 1] : [.18, .4, .7, .95]).forEach((weight, index) => { tokens[`--usage-level-${index + 1}`] = mixColor(bg, accent, weight); });
  return tokens;
}
export function defaultAppearance() { return { version: 1, revision: 0, enabled: false, selectedId: null, base: null, themes: [], images: [] }; }
export function themeDraft(theme) { const { name, base, colors, backgroundId, backgroundStrength } = theme; return { name, base, colors, backgroundId, backgroundStrength }; }
export function validateAppearance(value) {
  if (!only(value, ['version', 'revision', 'enabled', 'selectedId', 'base', 'themes', 'images']) || value.version !== 1 || !Number.isInteger(value.revision) || value.revision < 0
    || typeof value.enabled !== 'boolean' || (value.base != null && !['light', 'dark'].includes(value.base))
    || !Array.isArray(value.themes) || value.themes.length > 40 || !Array.isArray(value.images) || value.images.length > 32) throw Error('APPEARANCE_INVALID');
  const themes = value.themes.map(theme => {
    if (!only(theme, ['id', 'name', 'base', 'colors', 'backgroundId', 'backgroundStrength', 'source', 'createdAt', 'updatedAt']) || !THEME_ID.test(theme.id) || !['manual', 'ai'].includes(theme.source)
      || !Number.isFinite(Date.parse(theme.createdAt)) || !Number.isFinite(Date.parse(theme.updatedAt))) throw Error('APPEARANCE_INVALID');
    return { ...validateTheme(themeDraft(theme)), id: theme.id, source: theme.source, createdAt: theme.createdAt, updatedAt: theme.updatedAt };
  });
  const images = value.images.map(image => {
    if (!only(image, ['id', 'name', 'width', 'height']) || !IMAGE_ID.test(image.id) || typeof image.name !== 'string' || image.name.length > 120
      || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 16000000) throw Error('APPEARANCE_INVALID');
    return image;
  });
  if (new Set(themes.map(theme => theme.id)).size !== themes.length || new Set(images.map(image => image.id)).size !== images.length
    || themes.some(theme => theme.backgroundId && !images.some(image => image.id === theme.backgroundId))
    || (value.selectedId != null && !themes.some(theme => theme.id === value.selectedId))) throw Error('APPEARANCE_INVALID');
  return { version: 1, revision: value.revision, enabled: value.enabled, selectedId: value.selectedId || null, base: value.base || null, themes, images };
}
export function appendThemeCommand(draft) {
  const text = String(draft || '');
  return text.includes(THEME_COMMAND) ? text : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${THEME_COMMAND} `;
}
