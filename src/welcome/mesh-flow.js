import { meshGradientFragmentShader, getShaderColorFromString } from "@paper-design/shaders";
import { mountWelcomeShader } from "./paper-loop.js";

const sizing = {
  u_fit: 2,
  u_scale: 1.05,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
};

export function mountMeshFlow(host, hooks) {
  const color = getShaderColorFromString;
  const dark = host.ownerDocument.documentElement.getAttribute("data-theme") === "dark";
  const colors = (dark
    ? ["#132033", "#1a4466", "#245a86", "#16324a", "#2a6a96"]
    : ["#eef6fc", "#c9e4f7", "#b3d8f3", "#9ecff0", "#d6ecfa"]
  ).map(color);
  return mountWelcomeShader(host, {
    fragmentShader: meshGradientFragmentShader,
    maxPixels: 360_000,
    timeScale: 0.07,
    uniforms: {
      u_colors: colors,
      u_colorsCount: colors.length,
      u_distortion: 0.55,
      u_swirl: 0.22,
      u_grainMixer: 0,
      u_grainOverlay: 0,
      ...sizing,
    },
    ...hooks,
  });
}
