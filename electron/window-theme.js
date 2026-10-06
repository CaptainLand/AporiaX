// Native Windows caption buttons must match src/tokens.css, not the retired
// purple desktop palette. The same palette is used at creation and on toggle.
const palettes = Object.freeze({
  light: Object.freeze({ backgroundColor: "#ffffff", color: "#f8fafe", symbolColor: "#1c1e21", height: 38 }),
  dark: Object.freeze({ backgroundColor: "#0f1114", color: "#14161a", symbolColor: "#eaedf2", height: 38 }),
});

export function windowThemePalette(theme) {
  return palettes[theme === "dark" ? "dark" : "light"];
}
