import { PRESET_COLORS, themeDraft } from '../../shared/appearance.js';
export const APPEARANCE_TOOL_NAMES = new Set(['list_aporiax_themes', 'create_aporiax_theme']);
export const APPEARANCE_TOOLS = [
  { type: 'function', function: { name: 'list_aporiax_themes', description: 'Desktop main Agent only. Read the experimental appearance toggle, built-in color presets, saved theme summaries and imported background IDs. No account data, file paths or changes.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'create_aporiax_theme', description: 'When the user asks to design an AporiaX theme, save one validated candidate to Settings > Personalization. Requires the user to enable experimental appearance first. Never applies the theme or changes the toggle. The user previews and applies it in Settings. No CSS, JavaScript, HTML, file paths or remote URLs.', parameters: { type: 'object', properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 }, base: { type: 'string', enum: ['light', 'dark'] },
    colors: { type: 'object', properties: Object.fromEntries(['accent', 'background', 'panel', 'text'].map(key => [key, { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }])), required: ['accent', 'background', 'panel', 'text'], additionalProperties: false },
    backgroundId: { type: ['string', 'null'], description: 'Optional ID of an already user-imported image, returned by list_aporiax_themes. Never a URL or path.' },
    backgroundStrength: { type: 'number', minimum: 0, maximum: .18 },
  }, required: ['name', 'base', 'colors'], additionalProperties: false } } },
];
export function createAppearanceTools({ store, signal }) {
  return async (name, input = {}) => {
    signal?.throwIfAborted();
    if (!APPEARANCE_TOOL_NAMES.has(name)) throw Error('Unknown appearance tool');
    const snapshot = store.snapshot();
    if (name === 'list_aporiax_themes') {
      if (Object.keys(input).length) throw Error('No arguments are accepted');
      return { enabled: snapshot.enabled, revision: snapshot.revision, presets: PRESET_COLORS,
        themes: snapshot.themes.map(theme => ({ id: theme.id, ...themeDraft(theme, { includeLegacy: false }) })), images: snapshot.images.map(({ id, name, width, height }) => ({ id, name, width, height })),
        constraints: 'No layout/scripts/remote URLs. Text contrast >= 7 against both backgrounds. Light backgrounds: luminance >= .5 / panel >= .4; dark <= .12 / panel <= .16. The user applies candidates in Settings.' };
    }
    if (Object.keys(input).some(key => !['name', 'base', 'colors', 'backgroundId', 'backgroundStrength'].includes(key)) || Object.keys(input.colors || {}).some(key => !['accent', 'background', 'panel', 'text'].includes(key))) throw Error('THEME_INVALID_FIELDS');
    const saved = await store.change({ action: 'save', revision: snapshot.revision, theme: input }, { source: 'ai', signal });
    const theme = saved.themes.at(-1);
    return { status: 'candidate-saved', themeId: theme.id, name: theme.name, applied: false,
      message: '主题候选已保存到设置 > 个性化。请用户预览后点击应用。当前主题和实验开关没有变化。' };
  };
}
