import {
  ShaderMount,
  meshGradientFragmentShader,
  grainGradientFragmentShader,
  GrainGradientShapes,
  warpFragmentShader,
  WarpPatterns,
  swirlFragmentShader,
  simplexNoiseFragmentShader,
  metaballsFragmentShader,
  godRaysFragmentShader,
  gemSmokeFragmentShader,
  GemSmokeShapes,
  toProcessedGemSmoke,
  heatmapFragmentShader,
  toProcessedHeatmap,
  liquidMetalFragmentShader,
  LiquidMetalShapes,
  toProcessedLiquidMetal,
  getShaderColorFromString,
  getShaderNoiseTexture,
} from "@paper-design/shaders";

const LOGO_SRC = "./aporiax-logo-clean.png";
const brand = ["#b8f3ff", "#60a5fa", "#2563eb", "#1d4ed8", "#7dd3fc"];
const colors = brand.map(getShaderColorFromString);
const back = getShaderColorFromString("#1d4ed8");
const icySmoke = ["#d9f8ff", "#7dd3fc", "#38bdf8", "#60a5fa"].map(
  getShaderColorFromString,
);
const heatmapColors = [
  "#1e3a8a",
  "#1d4ed8",
  "#2563eb",
  "#38bdf8",
  "#7dd3fc",
  "#e0f2fe",
].map(getShaderColorFromString);

const sizing = {
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

const imageSizing = {
  ...sizing,
  u_fit: 1,
  u_scale: 0.62,
};

function meshUniforms(extra) {
  return {
    u_colors: colors,
    u_colorsCount: colors.length,
    u_distortion: 0.8,
    u_swirl: 0.12,
    u_grainMixer: 0,
    u_grainOverlay: 0,
    ...sizing,
    ...extra,
  };
}

const versions = [
  {
    id: "mesh",
    label: "Mesh 柔流",
    shader: meshGradientFragmentShader,
    speed: 0.4,
    uniforms: () => meshUniforms(),
  },
  {
    id: "mesh-swirl",
    label: "Mesh 漩涡",
    shader: meshGradientFragmentShader,
    speed: 0.55,
    uniforms: () =>
      meshUniforms({
        u_distortion: 1,
        u_swirl: 0.82,
        u_scale: 1.15,
      }),
  },
  {
    id: "grain",
    label: "Grain 波浪",
    shader: grainGradientFragmentShader,
    speed: 0.45,
    uniforms: ({ noise }) => ({
      u_colorBack: back,
      u_colors: colors,
      u_colorsCount: colors.length,
      u_softness: 0.82,
      u_intensity: 0.55,
      u_noise: 0.28,
      u_shape: GrainGradientShapes.wave,
      u_noiseTexture: noise,
      ...sizing,
    }),
  },
  {
    id: "warp",
    label: "Warp 大理石",
    shader: warpFragmentShader,
    speed: 0.35,
    uniforms: ({ noise }) => ({
      u_colors: colors,
      u_colorsCount: colors.length,
      u_proportion: 0.45,
      u_softness: 0.85,
      u_shape: WarpPatterns.stripes,
      u_shapeScale: 0.35,
      u_distortion: 0.72,
      u_swirl: 0.55,
      u_swirlIterations: 8,
      u_noiseTexture: noise,
      ...sizing,
      u_scale: 0.9,
    }),
  },
  {
    id: "swirl",
    label: "Swirl 螺旋",
    shader: swirlFragmentShader,
    speed: 0.4,
    uniforms: () => ({
      u_colorBack: getShaderColorFromString("#7dd3fc"),
      u_colors: colors,
      u_colorsCount: colors.length,
      u_bandCount: 9,
      u_twist: 0.58,
      u_center: 0,
      u_proportion: 0.5,
      u_softness: 0.42,
      u_noise: 0.12,
      u_noiseFrequency: 0.28,
      ...sizing,
      u_scale: 1.05,
    }),
  },
  {
    id: "simplex",
    label: "Simplex 丝绸",
    shader: simplexNoiseFragmentShader,
    speed: 0.4,
    uniforms: () => ({
      u_colors: colors,
      u_colorsCount: colors.length,
      u_stepsPerColor: 2,
      u_softness: 0.78,
      ...sizing,
      u_scale: 1.2,
    }),
  },
  {
    id: "metaballs",
    label: "Metaballs 液滴",
    shader: metaballsFragmentShader,
    speed: 0.45,
    uniforms: ({ noise }) => ({
      u_colorBack: back,
      u_colors: colors,
      u_colorsCount: colors.length,
      u_count: 12,
      u_size: 0.72,
      u_noiseTexture: noise,
      ...sizing,
    }),
  },
  {
    id: "god-rays",
    label: "God Rays 放射",
    shader: godRaysFragmentShader,
    speed: 0.35,
    uniforms: ({ noise }) => ({
      u_colorBack: getShaderColorFromString("#1e40af"),
      u_colorBloom: getShaderColorFromString("#7dd3fc"),
      u_colors: colors.slice(0, 5),
      u_colorsCount: 5,
      u_spotty: 0.28,
      u_midSize: 0.48,
      u_midIntensity: 0.42,
      u_density: 0.62,
      u_intensity: 0.82,
      u_bloom: 0.28,
      u_noiseTexture: noise,
      ...sizing,
    }),
  },
  {
    id: "gem-smoke",
    label: "Gem Smoke 烟光",
    shader: gemSmokeFragmentShader,
    speed: 0.55,
    imageShader: true,
    imageKey: "gemImage",
    uniforms: ({ gemImage }) => ({
      u_image: gemImage,
      u_isImage: true,
      u_shape: GemSmokeShapes.none,
      u_colors: icySmoke,
      u_colorsCount: icySmoke.length,
      u_colorBack: [0, 0, 0, 0],
      u_colorInner: getShaderColorFromString("#f4fbff"),
      u_innerDistortion: 0.72,
      u_outerDistortion: 0.48,
      u_outerGlow: 0.34,
      u_innerGlow: 1,
      u_offset: 0,
      u_angle: 18,
      u_size: 0.82,
      ...imageSizing,
    }),
  },
  {
    id: "heatmap",
    label: "Heatmap 流光",
    shader: heatmapFragmentShader,
    speed: 0.45,
    imageShader: true,
    imageKey: "heatmapImage",
    clipToLogo: true,
    uniforms: ({ heatmapImage }) => ({
      u_image: heatmapImage,
      u_colors: heatmapColors,
      u_colorsCount: heatmapColors.length,
      u_colorBack: [0, 0, 0, 0],
      u_contour: 0.52,
      u_angle: 28,
      u_noise: 0.04,
      u_innerGlow: 0.68,
      u_outerGlow: 0,
      ...imageSizing,
      u_fit: 2,
      u_scale: 1,
    }),
  },
  {
    id: "liquid-metal",
    label: "Liquid Metal 液态",
    shader: liquidMetalFragmentShader,
    speed: 0.55,
    imageShader: true,
    imageKey: "metalImage",
    uniforms: ({ metalImage }) => ({
      u_image: metalImage,
      u_isImage: true,
      u_shape: LiquidMetalShapes.none,
      u_colorBack: [0, 0, 0, 0],
      u_colorTint: getShaderColorFromString("#8ec5ff"),
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

const host = document.querySelector(".flow");
const nav = document.querySelector(".switcher");
const frame = document.querySelector(".frame");
if (!host || !nav || !frame) {
  throw new Error("AporiaX logo: missing mount or switcher");
}

let mount = null;
let activeId = versions[0].id;
const assets = {
  noise: undefined,
  gemImage: undefined,
  heatmapImage: undefined,
  metalImage: undefined,
};

async function loadNoise() {
  const img = getShaderNoiseTexture();
  if (!img) return undefined;
  if (typeof img.decode === "function") {
    await img.decode().catch(() => {});
  } else if (!img.complete) {
    await new Promise((resolve) => {
      img.onload = resolve;
      img.onerror = resolve;
    });
  }
  return img;
}

async function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  if (typeof img.decode === "function") {
    await img.decode();
  } else {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
  }
  return img;
}

async function processLogoImages() {
  const [gem, heat, metal] = await Promise.all([
    toProcessedGemSmoke(LOGO_SRC),
    toProcessedHeatmap(LOGO_SRC),
    toProcessedLiquidMetal(LOGO_SRC),
  ]);
  assets.gemImage = await blobToImage(gem.pngBlob);
  assets.heatmapImage = await blobToImage(heat.blob);
  assets.metalImage = await blobToImage(metal.pngBlob);
}

function versionById(id) {
  return versions.find((item) => item.id === id) ?? versions[0];
}

function imageReady(version) {
  return !version.imageKey || Boolean(assets[version.imageKey]);
}

function renderButtons() {
  nav.replaceChildren(
    ...versions.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.id = item.id;
      button.textContent = `${index + 1}  ${item.label}`;
      button.disabled = !imageReady(item);
      button.setAttribute("aria-pressed", String(item.id === activeId));
      button.addEventListener("click", () => select(item.id));
      return button;
    }),
  );
}

function select(id, pushHash = true) {
  const version = versionById(id);
  if (!imageReady(version)) return;
  if (mount) {
    mount.dispose();
    mount = null;
  }
  frame.classList.toggle(
    "is-image",
    Boolean(version.imageShader) && !version.clipToLogo,
  );
  mount = new ShaderMount(
    host,
    version.shader,
    version.uniforms(assets),
    { alpha: true, premultipliedAlpha: true },
    version.speed,
  );
  activeId = version.id;
  for (const button of nav.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.id === activeId));
  }
  if (pushHash && location.hash.replace(/^#/, "") !== version.id) {
    history.replaceState(null, "", `#${version.id}`);
  }
}

function idFromHash() {
  return location.hash.replace(/^#/, "");
}

renderButtons();

async function initialize() {
  assets.noise = await loadNoise();
  const startId = idFromHash() || versions[0].id;
  const start = versionById(startId);
  const processing = processLogoImages()
    .then(() => renderButtons())
    .catch((error) => {
      console.error("AporiaX logo image filters failed:", error);
    });
  if (start.imageShader) await processing;
  select(startId, false);

  window.addEventListener("hashchange", () => {
    const next = idFromHash();
    if (next && next !== activeId) select(next, false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    let nextIndex = -1;
    if (event.key >= "1" && event.key <= "9") {
      nextIndex = Number(event.key) - 1;
    } else if (event.key === "0") {
      nextIndex = 9;
    }
    if (nextIndex >= 0 && nextIndex < versions.length) {
      event.preventDefault();
      select(versions[nextIndex].id);
      return;
    }
    const index = versions.findIndex((item) => item.id === activeId);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      select(versions[(index + 1) % versions.length].id);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      select(versions[(index - 1 + versions.length) % versions.length].id);
    }
  });
}

initialize().catch((error) => {
  console.error("AporiaX logo initialization failed:", error);
  host.style.background = "#2563eb";
  host.setAttribute("data-shader-error", "true");
});
