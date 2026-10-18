import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTheme, themeDraft, themeTokens, PRESET_COLORS } from '../shared/appearance.js';
import { createAppearanceStore } from '../electron/appearance/store.js';
import { createAppearanceTools, APPEARANCE_TOOLS } from '../electron/runtime/appearance-tools.js';
import { windowThemePalette } from '../electron/window-theme.js';

const basic = { name: 'Basic', base: 'dark', colors: { ...PRESET_COLORS.dark } };
const legacy = { ...basic, name: 'Preserved', colors: { ...basic.colors, quota: '#5cd4a8', icon: '#e8b46d', secondary: '#b9a4ed' },
  gradient: { enabled: true, start: '#13271d', end: '#273a53', angle: 90, strength: .65 },
  regions: { sidebar: '#17201c' }, shape: { radius: 18, borderWidth: 0 },
  components: { composer: { background: '#20241f', radius: 0 }, terminal: { background: '#101c15' } } };
const root = await mkdtemp(join(tmpdir(), 'aporia-basic-rollback-'));
try {
  const preserved = validateTheme(legacy);
  assert.deepEqual(themeTokens(preserved), themeTokens(validateTheme(basic)), 'Every retired option is inactive, including gradient');
  assert.equal(windowThemePalette(preserved).color, basic.colors.panel);
  assert.equal(themeTokens(preserved)['--theme-panel-gradient'], undefined);
  const copy = themeDraft(preserved); copy.gradient.enabled = false; copy.components.composer.radius = 24;
  assert.equal(preserved.gradient.enabled, true); assert.equal(preserved.components.composer.radius, 0);
  const store = await createAppearanceStore(root);
  await store.change({ action: 'preferences', revision: 0, enabled: true });
  await store.change({ action: 'save', revision: 1, theme: legacy });
  const id = store.snapshot().themes[0].id;
  await store.change({ action: 'preferences', revision: 2, selectedId: id });
  const restarted = await createAppearanceStore(root);
  assert.equal(restarted.snapshot().error, undefined); assert.equal(restarted.snapshot().selectedId, id);
  assert.deepEqual(themeDraft(restarted.snapshot().themes[0]), preserved);
  await restarted.change({ action: 'save', revision: 3, id, theme: { ...themeDraft(restarted.snapshot().themes[0]), colors: { ...legacy.colors, accent: '#a3c457' } } });
  const final = (await createAppearanceStore(root)).snapshot().themes[0];
  assert.deepEqual(final.gradient, legacy.gradient); assert.deepEqual(final.components, legacy.components); assert.deepEqual(final.regions, legacy.regions);
  assert.equal(final.colors.quota, legacy.colors.quota);
  const tools = createAppearanceTools({ store: restarted });
  await assert.rejects(tools('create_aporiax_theme', legacy), /THEME_INVALID_FIELDS/);
  await tools('create_aporiax_theme', basic);
  assert.equal(restarted.snapshot().selectedId, null, 'AI only saves basic candidates');
  const list = await tools('list_aporiax_themes');
  assert(!list.themes[0].gradient && !list.themes[0].components && !list.themes[0].colors.quota);
  const schema = APPEARANCE_TOOLS[1].function.parameters;
  assert(!schema.properties.gradient && !schema.properties.components && !schema.properties.shape);
  assert.deepEqual(Object.keys(schema.properties.colors.properties), ['accent', 'background', 'panel', 'text']);
  for (const change of [{ gradient: { ...legacy.gradient, start: 'url(secret)' } }, { gradient: { ...legacy.gradient, css: 'display:none' } }, { shape: { radius: 99 } }, { components: { unknown: {} } }]) assert.throws(() => validateTheme({ ...legacy, ...change }));
  console.log('PASS basic-only rollback: retired gradients/regions/component/color overrides have no visual effects, saved settings survive load/edit/restart/copy, basic AI schema/candidates and unknown fields rejected.');
} finally { await rm(root, { recursive: true, force: true }); }
