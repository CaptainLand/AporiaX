import { ShaderMount } from "@paper-design/shaders";

export const WELCOME_MAX_PIXELS = 480_000;
export const WELCOME_MAX_FPS = 120;

const WEBGL = { alpha: true, antialias: false, powerPreference: "low-power" };

export function mountWelcomeShader(host, {
  fragmentShader,
  uniforms,
  maxPixels = WELCOME_MAX_PIXELS,
  mipmaps = [],
  timeScale = 0.24,
  startFrame = 0,
  prepare,
  onReady = () => {},
  onError = () => {},
}) {
  let disposed = false;
  let mount;
  let canvas;
  let raf = 0;
  let lastDraw = null;
  let frame = startFrame;
  let visible = true;
  let ready = false;
  const doc = host.ownerDocument;
  const interval = 1000 / WELCOME_MAX_FPS;
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    lastDraw = null;
  };
  const tick = (now) => {
    raf = 0;
    if (disposed || doc.hidden || !visible || !mount) return;
    const elapsed = lastDraw === null ? interval : now - lastDraw;
    if (elapsed >= interval - 0.15 && mount.canvasElement.width > 0) {
      frame += Math.min(elapsed, 50) * timeScale;
      mount.setFrame(frame);
      lastDraw = now;
      if (!ready) {
        ready = true;
        canvas?.removeAttribute("data-pending");
        onReady();
      }
    }
    raf = requestAnimationFrame(tick);
  };
  const resume = () => {
    stop();
    if (!disposed && mount && visible && !doc.hidden) raf = requestAnimationFrame(tick);
  };
  const unbindContext = () => {
    canvas?.removeEventListener("webglcontextlost", onContextLost);
  };
  const releaseMount = () => {
    unbindContext();
    mount?.dispose();
    mount = undefined;
    canvas = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    observer.disconnect();
    doc.removeEventListener("visibilitychange", resume);
    releaseMount();
  };
  const fail = (error) => {
    if (disposed) return;
    dispose();
    onError(error);
  };
  const onContextLost = () => fail(new Error("Welcome WebGL context lost"));
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    resume();
  });
  observer.observe(host);
  doc.addEventListener("visibilitychange", resume);

  const initialize = async () => {
    const extra = prepare ? await prepare() : uniforms;
    if (disposed) return;
    const existing = new Set(host.querySelectorAll("canvas"));
    try {
      mount = new ShaderMount(
        host,
        fragmentShader,
        extra,
        WEBGL,
        0,
        frame,
        1,
        maxPixels,
        mipmaps,
      );
    } catch (error) {
      for (const next of host.querySelectorAll("canvas")) {
        if (!existing.has(next)) next.remove();
      }
      throw error;
    }
    if (!mount.program) throw new Error("Welcome shader compilation failed");
    canvas = mount.canvasElement;
    canvas.setAttribute("data-pending", "");
    canvas.addEventListener("webglcontextlost", onContextLost);
    resume();
  };
  void initialize().catch(fail);
  return dispose;
}
