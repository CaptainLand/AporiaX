// Read-only compatibility for themes saved by the advanced editor. Preserve
// these values through load/edit/copy/save, but never turn them into CSS tokens.
const regions = ['sidebar', 'titlebar', 'conversation', 'workbench'];
const components = ['composer', 'bubble', 'witness', 'code', 'card', 'terminal'];
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('THEME_INVALID_FIELDS');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry == null) continue;
    if (['radius', 'borderWidth'].includes(key)) {
      if (!Number.isInteger(entry) || entry < 0 || entry > (key === 'radius' ? 24 : 2)) throw Error('THEME_INVALID_FIELDS');
      result[key] = entry;
    } else {
      if (!hex(entry)) throw Error('THEME_INVALID_COLORS');
      result[key] = entry.toLowerCase();
    }
  }
  return result;
}
export function legacyThemeFields(input) {
  const result = {};
  if (input.gradient != null) {
    const value = input.gradient;
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'start', 'end', 'angle', 'strength'].includes(key))
      || typeof value.enabled !== 'boolean' || !hex(value.start) || !hex(value.end)
      || !Number.isInteger(value.angle) || value.angle < 0 || value.angle > 360
      || typeof value.strength !== 'number' || !Number.isFinite(value.strength) || value.strength < 0 || value.strength > 1) throw Error('THEME_INVALID_GRADIENT');
    result.gradient = { enabled: value.enabled, start: value.start.toLowerCase(), end: value.end.toLowerCase(), angle: value.angle, strength: value.strength };
  }
  for (const [key, allowed] of [['regions', regions], ['shape', ['radius', 'borderWidth', 'border']]]) {
    if (input[key] != null) result[key] = fields(input[key], allowed);
  }
  if (input.components != null) {
    if (typeof input.components !== 'object' || Array.isArray(input.components) || Object.keys(input.components).some(key => !components.includes(key))) throw Error('THEME_INVALID_FIELDS');
    result.components = Object.fromEntries(Object.entries(input.components).map(([id, value]) => [id, value == null ? null : fields(value, ['background', 'text', 'border', 'radius', 'borderWidth'])]));
  }
  return result;
}
export function legacyThemeColors(colors) { return fields(Object.fromEntries(['secondary', 'quota', 'icon'].filter(key => colors[key] != null).map(key => [key, colors[key]])), ['secondary', 'quota', 'icon']); }
