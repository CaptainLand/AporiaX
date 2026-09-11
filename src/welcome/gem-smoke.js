import { gemSmokeFragmentShader, getShaderColorFromString } from "@paper-design/shaders";
import textureUrl from "./logo-gem-texture.png";
import { mountWelcomeShader, WELCOME_MAX_PIXELS, WELCOME_MAX_FPS } from "./paper-loop.js";

export { WELCOME_MAX_PIXELS, WELCOME_MAX_FPS };

export function mountGemSmoke(host, hooks) {
  const color = getShaderColorFromString;
  return mountWelcomeShader(host, {
    fragmentShader: gemSmokeFragmentShader,
    maxPixels: WELCOME_MAX_PIXELS,
    // The 1254px RG data texture is usually shown at 250-520px. Trilinear
    // minification averages that pixel footprint instead of skipping alpha texels.
    mipmaps: ["u_image"],
    startFrame: 1800,
    timeScale: 0.24,
    prepare: async () => {
      const texture = new Image();
      texture.src = textureUrl;
      await texture.decode();
      return {
        u_image: texture,
        u_isImage: true,
        u_shape: 0,
        u_colors: ["#baeaff", "#4abbed", "#176de2", "#85dfff", "#257bd5", "#baeaff"].map(color),
        u_colorsCount: 5,
        u_colorBack: color("#00000000"),
        u_colorInner: color("#dff3ff"),
        u_innerDistortion: 0.38,
        u_outerDistortion: 0.25,
        u_outerGlow: 0.18,
        u_innerGlow: 0.96,
        u_offset: 0,
        u_angle: -20,
        u_size: 0.88,
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
    },
    ...hooks,
  });
}
