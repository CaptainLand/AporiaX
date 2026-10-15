// Native Windows caption buttons must match src/tokens.css, not the retired
// purple desktop palette. The same palette is used at creation and on toggle.
import { validateTheme } from '../shared/appearance.js';
const palettes = Object.freeze({
  light: Object.freeze({ backgroundColor: "#ffffff", color: "#f3f4f6", symbolColor: "#25282d", height: 38 }),
  dark: Object.freeze({ backgroundColor: "#0f1114", color: "#14161a", symbolColor: "#eaedf2", height: 38 }),
});

export function windowThemePalette(theme) {
  if (theme && typeof theme === 'object') {
    const { base, colors } = validateTheme({ name: 'Native theme', base: theme.base, colors: theme.colors });
    return { backgroundColor: colors.background, color: colors.panel, symbolColor: colors.text, height: palettes[base].height };
  }
  return palettes[theme === "dark" ? "dark" : "light"];
}
