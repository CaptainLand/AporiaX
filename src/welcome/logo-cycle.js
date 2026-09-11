import {
  meshGradientFragmentShader,
  grainGradientFragmentShader,
  GrainGradientShapes,
  warpFragmentShader,
  WarpPatterns,
  simplexNoiseFragmentShader,
  metaballsFragmentShader,
  liquidMetalFragmentShader,
  LiquidMetalShapes,
  getShaderColorFromString,
  getShaderNoiseTexture,
} from "@paper-design/shaders";
import { mountGemSmoke } from "./gem-smoke.js";
import { mountWelcomeShader, WELCOME_MAX_PIXELS } from "./paper-loop.js";
import metalTextureUrl from "./logo-liquid-metal-texture.png";

const color = getShaderColorFromString;
const brand = ["#b8f3ff", "#60a5fa", "#2563eb", "#1d4ed8", "#7dd3fc"].map(color);
const back = color("#1d4ed8");

const patternSizing = {
  u_fit: 2,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
};

// Same placement as the current Gem Smoke logo: 88% of the art square.
const imageSizing = {
  u_fit: 1,
  u_scale: 0.88,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
};

function mesh(extra = {}) {
  return {
    u_colors: brand,
    u_colorsCount: brand.length,
    u_distortion: 0.8,
    u_swirl: 0.12,
    u_grainMixer: 0,
    u_grainOverlay: 0,
    ...patternSizing,
    ...extra,
  };
}

export const LOGO_CYCLE = [
  { id: "gem-smoke", kind: "image", timeScale: 0.24 },
  {
    id: "mesh",
    kind: "masked",
    timeScale: 0.22,
    shader: meshGradientFragmentShader,
    uniforms: () => mesh(),
  },
  {
    id: "mesh-swirl",
    kind: "masked",
    timeScale: 0.24,
    shader: meshGradientFragmentShader,
    uniforms: () => mesh({ u_distortion: 1, u_swirl: 0.82, u_scale: 1.15 }),
  },
  {
    id: "grain",
    kind: "masked",
    timeScale: 0.22,
    shader: grainGradientFragmentShader,
    uniforms: ({ noise }) => ({
      u_colorBack: back,
      u_colors: brand,
      u_colorsCount: brand.length,
      u_softness: 0.82,
      u_intensity: 0.55,
      u_noise: 0.28,
      u_shape: GrainGradientShapes.wave,
      u_noiseTexture: noise,
      ...patternSizing,
    }),
  },
  {
    id: "warp",
    kind: "masked",
    timeScale: 0.2,
    shader: warpFragmentShader,
    uniforms: ({ noise }) => ({
      u_colors: brand,
      u_colorsCount: brand.length,
      u_proportion: 0.45,
      u_softness: 0.85,
      u_shape: WarpPatterns.stripes,
      u_shapeScale: 0.35,
      u_distortion: 0.72,
      u_swirl: 0.55,
      u_swirlIterations: 8,
      u_noiseTexture: noise,
      ...patternSizing,
      u_scale: 0.9,
    }),
  },
  {
    id: "simplex",
    kind: "masked",
    timeScale: 0.22,
    shader: simplexNoiseFragmentShader,
    uniforms: () => ({
      u_colors: brand,
      u_colorsCount: brand.length,
      u_stepsPerColor: 2,
      u_softness: 0.78,
      ...patternSizing,
      u_scale: 1.2,
    }),
  },
  {
    id: "metaballs",
    kind: "masked",
    timeScale: 0.22,
    shader: metaballsFragmentShader,
    uniforms: ({ noise }) => ({
      u_colorBack: back,
      u_colors: brand,
      u_colorsCount: brand.length,
      u_count: 12,
      u_size: 0.72,
      u_noiseTexture: noise,
      ...patternSizing,
    }),
  },
  {
    id: "liquid-metal",
    kind: "image",
    timeScale: 0.24,
    shader: liquidMetalFragmentShader,
    uniforms: ({ metal }) => ({
      u_image: metal,
      u_isImage: true,
      u_shape: LiquidMetalShapes.none,
      u_colorBack: [0, 0, 0, 0],
      u_colorTint: color("#8ec5ff"),
      u_repetition: 2.2,
      u_shiftRed: 0.16,
      u_shiftBlue: 0.34,
      u_contour: 0.45,
      u_softness: 0.08,
      u_distortion: 0.08,
      u_angle: 70,
      ...imageSizing,
    }),
  },
];

export async function loadLogoCycleAssets() {
  const noise = getShaderNoiseTexture();
  if (noise && typeof noise.decode === "function") {
    await noise.decode().catch(() => {});
  }
  const metal = new Image();
  metal.src = metalTextureUrl;
  await metal.decode();
  return { noise, metal };
}

export function mountLogoEffect(host, effect, assets, hooks) {
  if (effect.id === "gem-smoke") return mountGemSmoke(host, hooks);
  return mountWelcomeShader(host, {
    fragmentShader: effect.shader,
    maxPixels: WELCOME_MAX_PIXELS,
    timeScale: effect.timeScale,
    startFrame: 1800,
    prepare: async () => effect.uniforms(assets),
    ...hooks,
  });
}
