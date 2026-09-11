import { liquidMetalFragmentShader, LiquidMetalShapes, getShaderColorFromString, emptyPixel } from "@paper-design/shaders";
import { mountWelcomeShader } from "./paper-loop.js";

export function mountLiquidMetal(host, hooks) {
  const color = getShaderColorFromString;
  return mountWelcomeShader(host, {
    fragmentShader: liquidMetalFragmentShader,
    maxPixels: 80_000,
    timeScale: 0.22,
    prepare: async () => {
      const texture = new Image();
      texture.src = emptyPixel;
      await texture.decode();
      return {
        u_image: texture,
        u_colorBack: color("#245a86"),
        u_colorTint: color("#d7f2ff"),
        u_repetition: 2.8,
        u_softness: 0.62,
        u_shiftRed: 0.08,
        u_shiftBlue: 0.12,
        u_distortion: 0.18,
        u_contour: 0.4,
        u_angle: 38,
        u_shape: LiquidMetalShapes.none,
        u_isImage: false,
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
    },
    ...hooks,
  });
}
