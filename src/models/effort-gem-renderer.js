import { gemSmokeFragmentShader, getShaderColorFromString, toProcessedGemSmoke } from '@paper-design/shaders';
import { mountWelcomeShader } from '../welcome/paper-loop.js';

let texturePromise;
function fillTexture() {
  if (!texturePromise) texturePromise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Gem texture canvas is unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 512, 512);
    // Data URLs honor the desktop's existing CSP without permitting blob: images.
    const processed = await toProcessedGemSmoke(canvas.toDataURL('image/png'));
    const src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(processed.pngBlob);
    });
    const image = new Image();
    image.src = src;
    await image.decode();
    return image;
  })().catch(error => { texturePromise = undefined; throw error; });
  return texturePromise;
}

export function mountEffortGem(host, { getSpeed = () => 1, ...hooks }) {
  const color = getShaderColorFromString;
  return mountWelcomeShader(host, {
    fragmentShader: gemSmokeFragmentShader,
    maxPixels: 160_000, maxFps: 30, mipmaps: ['u_image'], startFrame: 1800, timeScale: .24,
    getTimeScale: () => .24 * getSpeed(),
    prepare: async () => ({
      u_image: await fillTexture(), u_isImage: true, u_shape: 0,
      u_colors: ['#baeaff', '#4abbed', '#176de2', '#85dfff', '#257bd5', '#baeaff'].map(color),
      u_colorsCount: 5, u_colorBack: color('#00000000'), u_colorInner: color('#dff3ff'),
      u_innerDistortion: .38, u_outerDistortion: .25, u_outerGlow: 0, u_innerGlow: .96,
      u_offset: 0, u_angle: -20, u_size: 1, u_fit: 2, u_scale: 1, u_rotation: 0,
      u_offsetX: 0, u_offsetY: 0, u_originX: .5, u_originY: .5, u_worldWidth: 0, u_worldHeight: 0,
    }),
    ...hooks,
  });
}
