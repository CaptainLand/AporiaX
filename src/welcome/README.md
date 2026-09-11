# Welcome Gem Smoke

Desktop opening uses the clean AX PNG plus Paper Shaders Gem Smoke. The original logo is never edited.

## Displayed logo

- File: `aporiax-logo-clean.png` at the repository root.
- SHA-256: `5e4c8c77c1f50f577885b7b07b13dc6d91dcce0bb61c5700eef8849d0acf2a35`
- Do not regenerate, restyle, or stretch this PNG.

## Precomputed texture

`logo-gem-texture.png` is Paper's RG edge/alpha data for Gem Smoke. `logo-liquid-metal-texture.png` is the matching Liquid Metal data. Neither is a picture to show. They exist so startup does not run Poisson contour solving.

Regenerate after changing the source PNG (do not change it unless the user supplies a new original):

```powershell
node scripts/prepare-welcome-logo.mjs
```

Uses the installed `@paper-design/shaders` 0.0.80 `toProcessedGemSmoke()` helper via Vite + Playwright/Edge. Paper Shaders is Apache-2.0; see `node_modules/@paper-design/shaders/LICENSE` and `NOTICE`.

## Edge sampling

Gem Smoke enables `mipmaps: ["u_image"]` through `mountWelcomeShader`. The source
texture is 1254px square but its displayed logo is normally much smaller. Plain
bilinear minification skips fine alpha details, creating a speckled silhouette;
the mip chain supplies prefiltered levels and trilinear sampling for that footprint.

This does not edit the original PNG, change the silhouette or blur the whole logo.
The 480,000-pixel / 120-FPS caps and the other seven logo effects stay unchanged.
Mipmaps add roughly one third to this texture's GPU storage, not to the render area.

Regression: `node tests/welcome-edge-browser.mjs` (fixed frame, real GPU filter),
then `node tests/welcome-gem-browser.mjs` (production CSP, all eight effects,
Enter/disposal, reduced motion, themes and fallbacks).

## CSP

Desktop `style-src` is `'self'` only. Paper's `ShaderMount` would otherwise inject an inline stylesheet. `vite.config.js` strips that injection at build time. Canvas layout CSS is in `welcome.css`. Do not add `unsafe-inline`.
