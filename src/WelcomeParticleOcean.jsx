import { useEffect, useRef } from "react";

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function hash(x, y, seed = 0) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return value - Math.floor(value);
}

function smoothNoise(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hash(x0, y0, seed);
  const n10 = hash(x0 + 1, y0, seed);
  const n01 = hash(x0, y0 + 1, seed);
  const n11 = hash(x0 + 1, y0 + 1, seed);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function fbm(x, y, seed = 0) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;

  for (let octave = 0; octave < 4; octave += 1) {
    value +=
      smoothNoise(x * frequency, y * frequency, seed + octave * 7) * amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }

  return value / 0.9375;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSquared = abx * abx + aby * aby || 1;
  const t = clamp((apx * abx + apy * aby) / lengthSquared, 0, 1);
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function ellipseField(nx, ny, cx, cy, rx, ry, softness = 0.22) {
  const distance = Math.sqrt(((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2);
  return clamp((1 + softness - distance) / softness, 0, 1);
}

function bandField(nx, ny, ax, ay, bx, by, thickness, softness = 0.04) {
  const distance = distanceToSegment(nx, ny, ax, ay, bx, by);
  return clamp((thickness + softness - distance) / softness, 0, 1);
}

function densityAt(nx, ny) {
  const terrain =
    fbm(nx * 3.1 + 0.3, ny * 3.1 - 0.4, 4) * 0.72 +
    fbm(nx * 8, ny * 8, 11) * 0.28;
  const topShelf =
    ellipseField(nx, ny, 0.68, 0.13, 0.39, 0.14, 0.28) *
    (0.45 + terrain * 0.75);
  const leftShelf =
    ellipseField(nx, ny, 0.15, 0.28, 0.24, 0.18, 0.3) *
    (0.3 + terrain * 0.78);
  const lowerShelf =
    ellipseField(nx, ny, 0.48, 0.88, 0.44, 0.16, 0.3) *
    (0.38 + terrain * 0.7);
  const rightIsland =
    ellipseField(nx, ny, 0.96, 0.62, 0.11, 0.22, 0.35) *
    (0.3 + terrain * 0.78);
  const xBandA = bandField(nx, ny, 0.26, 0.1, 0.73, 0.72, 0.078, 0.045);
  const xBandB = bandField(nx, ny, 0.73, 0.09, 0.29, 0.73, 0.072, 0.045);
  const erosion = 0.3 + terrain * 0.95;
  const xField = Math.max(xBandA, xBandB) * erosion;
  const centerHalo =
    ellipseField(nx, ny, 0.5, 0.46, 0.24, 0.19, 0.35) *
    (0.25 + terrain * 0.68);
  const bottomRibbonY = 0.79 + Math.sin(nx * 7.4) * 0.035;
  const bottomRibbon =
    clamp((0.1 - Math.abs(ny - bottomRibbonY)) / 0.07, 0, 1) *
    clamp((nx - 0.03) / 0.16, 0, 1) *
    clamp((0.94 - nx) / 0.18, 0, 1) *
    (0.34 + terrain * 0.66);

  let density = Math.max(
    topShelf,
    leftShelf * 0.78,
    lowerShelf,
    rightIsland,
    xField * 0.92,
    centerHalo * 0.54,
    bottomRibbon,
  );

  const cutA = ellipseField(nx, ny, 0.5, 0.34, 0.09, 0.055, 0.35);
  const cutB = ellipseField(nx, ny, 0.39, 0.57, 0.08, 0.045, 0.35);
  const cutC = ellipseField(nx, ny, 0.64, 0.55, 0.07, 0.04, 0.35);
  density *= 1 - Math.max(cutA * 0.48, cutB * 0.6, cutC * 0.55);

  const edgeFade =
    clamp(nx / 0.035, 0, 1) *
    clamp((1 - nx) / 0.035, 0, 1) *
    clamp(ny / 0.035, 0, 1) *
    clamp((1 - ny) / 0.035, 0, 1);

  return clamp(density * edgeFade, 0, 1);
}

function accentAt(nx, ny, seed) {
  const diagonalWave = 0.5 + 0.5 * Math.sin(nx * 17 - ny * 11 + seed * 0.7);
  const veinA = bandField(nx, ny, 0.3, 0.1, 0.7, 0.7, 0.022, 0.035);
  const veinB = bandField(nx, ny, 0.71, 0.1, 0.31, 0.7, 0.018, 0.03);
  const lowerVein = clamp(
    (0.045 - Math.abs(ny - (0.79 + Math.sin(nx * 7.4) * 0.035))) / 0.045,
    0,
    1,
  );
  const regional =
    ellipseField(nx, ny, 0.7, 0.17, 0.28, 0.1, 0.36) * 0.6 +
    ellipseField(nx, ny, 0.46, 0.86, 0.34, 0.085, 0.38) * 0.58;
  const noisy = fbm(nx * 7.5, ny * 7.5, 29);

  return clamp(
    Math.max(veinA, veinB * 0.85, lowerVein * 0.72, regional * noisy) *
      (0.28 + diagonalWave * 0.72),
    0,
    1,
  );
}

export default function WelcomeParticleOcean() {
  const staticCanvasRef = useRef(null);
  const dynamicCanvasRef = useRef(null);

  useEffect(() => {
    const staticCanvas = staticCanvasRef.current;
    const dynamicCanvas = dynamicCanvasRef.current;
    const staticContext = staticCanvas?.getContext("2d", { alpha: false });
    const dynamicContext = dynamicCanvas?.getContext("2d", { alpha: true });
    if (!staticCanvas || !dynamicCanvas || !staticContext || !dynamicContext) {
      return undefined;
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const maximumFps = 120;
    const minimumFrameInterval = 1000 / maximumFps;
    const drawBucketStyles = [
      "rgba(123, 132, 148, 0.22)",
      "rgba(145, 153, 169, 0.34)",
      "rgba(173, 180, 194, 0.46)",
      "rgba(103, 157, 188, 0.36)",
      "rgba(78, 178, 222, 0.48)",
      "rgba(93, 202, 244, 0.62)",
      "rgba(117, 218, 255, 0.76)",
      "rgba(152, 231, 255, 0.9)",
    ];
    const state = {
      width: 0,
      height: 0,
      staticDpr: 1,
      dynamicScale: 1,
      particles: [],
      dynamicParticles: [],
      drawBuckets: drawBucketStyles.map(() => []),
      pointer: {
        x: -9999,
        y: -9999,
        targetX: -9999,
        targetY: -9999,
        active: false,
      },
      pulse: {
        x: 0,
        y: 0,
        startedAt: -9999,
      },
      lastFrame: performance.now(),
      animationFrame: 0,
      resizeTimer: 0,
      visible: !document.hidden,
      disposed: false,
    };

    const phasePair = (angle) => ({
      sin: Math.sin(angle),
      cos: Math.cos(angle),
    });

    const oscillateSin = (globalSin, globalCos, phase) =>
      globalSin * phase.cos + globalCos * phase.sin;

    const oscillateCos = (globalSin, globalCos, phase) =>
      globalCos * phase.cos - globalSin * phase.sin;

    function buildFieldMap() {
      const columns = Math.min(128, Math.max(64, Math.ceil(state.width / 22)));
      const rows = Math.min(76, Math.max(42, Math.ceil(state.height / 22)));
      const density = new Float32Array((columns + 1) * (rows + 1));
      const accent = new Float32Array((columns + 1) * (rows + 1));
      for (let row = 0; row <= rows; row += 1) {
        for (let column = 0; column <= columns; column += 1) {
          const nx = column / columns;
          const ny = row / rows;
          const index = row * (columns + 1) + column;
          density[index] = densityAt(nx, ny);
          accent[index] = accentAt(nx, ny, 0);
        }
      }
      return { columns, rows, density, accent };
    }

    function sampleField(field, values, nx, ny) {
      const x = clamp(nx, 0, 1) * field.columns;
      const y = clamp(ny, 0, 1) * field.rows;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(field.columns, x0 + 1);
      const y1 = Math.min(field.rows, y0 + 1);
      const tx = x - x0;
      const ty = y - y0;
      const stride = field.columns + 1;
      const top =
        values[y0 * stride + x0] * (1 - tx) +
        values[y0 * stride + x1] * tx;
      const bottom =
        values[y1 * stride + x0] * (1 - tx) +
        values[y1 * stride + x1] * tx;
      return top * (1 - ty) + bottom * ty;
    }

    function buildParticles() {
      const particles = [];
      const field = buildFieldMap();
      const compact = state.width < 700;
      const spacing = compact
        ? 11
        : state.width > 2600
          ? 9.6
          : state.width > 1500
            ? 8.7
            : 9.1;
      const columns = Math.ceil(state.width / spacing);
      const rows = Math.ceil(state.height / spacing);
      const randomSeed = (state.width * 0.013 + state.height * 0.017) % 100;

      for (let row = 0; row <= rows; row += 1) {
        for (let column = 0; column <= columns; column += 1) {
          const baseX = column * spacing + (row % 2) * spacing * 0.18;
          const baseY = row * spacing;
          const nx = baseX / state.width;
          const ny = baseY / state.height;
          const density = sampleField(field, field.density, nx, ny);
          const sparseNoise = hash(column, row, 91 + randomSeed);
          const ambientChance =
            0.0035 +
            hash(Math.floor(column / 4), Math.floor(row / 4), 51) * 0.007;

          if (sparseNoise > density * 0.82 + ambientChance) continue;

          const seed = hash(column, row, randomSeed);
          const accent = clamp(
            sampleField(field, field.accent, nx, ny) * (0.72 + seed * 0.56),
            0,
            1,
          );
          const edge = density < 0.2;
          const baseSize = compact ? 2 : 2.4;

          const phase = seed * Math.PI * 2;
          const phaseSecondary = hash(column, row, 33) * Math.PI * 2;
          particles.push({
            baseX,
            baseY,
            x: baseX,
            y: baseY,
            vx: 0,
            vy: 0,
            phase,
            phaseSecondary,
            waveXPhase: phasePair(phase + baseY * 0.011),
            waveYPhase: phasePair(phaseSecondary + baseX * 0.009),
            fieldPhase: phasePair(baseX * 0.006 + baseY * 0.0035),
            shimmerPhase: phasePair(phase + baseX * 0.014),
            travelPhase: phasePair(baseX * 0.013 - baseY * 0.007),
            density,
            accent,
            baseAlpha: edge
              ? 0.18 + seed * 0.22
              : 0.24 + density * 0.46 + seed * 0.14,
            size: baseSize + seed * (compact ? 1.1 : 1.7),
            drift: 0.45 + hash(column, row, 67) * 1.35,
          });
        }
      }

      const floaterCount = compact
        ? 90
        : Math.min(330, Math.floor((state.width * state.height) / 7000));

      for (let index = 0; index < floaterCount; index += 1) {
        const baseX = hash(index, 17, 4) * state.width;
        const baseY = hash(index, 29, 8) * state.height;
        const seed = hash(index, 41, 12);
        const phase = seed * Math.PI * 2;
        const phaseSecondary = hash(index, 31, 7) * Math.PI * 2;
        particles.push({
          baseX,
          baseY,
          x: baseX,
          y: baseY,
          vx: 0,
          vy: 0,
          phase,
          phaseSecondary,
          waveXPhase: phasePair(phase + baseY * 0.011),
          waveYPhase: phasePair(phaseSecondary + baseX * 0.009),
          fieldPhase: phasePair(baseX * 0.006 + baseY * 0.0035),
          shimmerPhase: phasePair(phase + baseX * 0.014),
          travelPhase: phasePair(baseX * 0.013 - baseY * 0.007),
          density: 0.08,
          accent: seed > 0.91 ? 0.36 : 0,
          baseAlpha: 0.12 + seed * 0.16,
          size: 1.5 + seed * 1.6,
          drift: 0.8 + seed * 1.5,
        });
      }

      state.particles = particles;
      const dynamicLimit = compact
        ? 420
        : Math.min(
            1_250,
            Math.max(720, Math.round((state.width * state.height) / 2_300)),
          );
      state.dynamicParticles = [...particles]
        .sort((left, right) => {
          const leftScore =
            left.accent * 2.6 +
            left.density * 0.35 +
            hash(left.baseX, left.baseY, 143) * 0.85;
          const rightScore =
            right.accent * 2.6 +
            right.density * 0.35 +
            hash(right.baseX, right.baseY, 143) * 0.85;
          return rightScore - leftScore;
        })
        .slice(0, dynamicLimit);
    }

    function drawStaticLayer() {
      staticContext.setTransform(
        state.staticDpr,
        0,
        0,
        state.staticDpr,
        0,
        0,
      );
      staticContext.fillStyle = "#0d0912";
      staticContext.fillRect(0, 0, state.width, state.height);
      const glow = staticContext.createRadialGradient(
        state.width * 0.57,
        state.height * 0.44,
        0,
        state.width * 0.57,
        state.height * 0.44,
        Math.max(state.width, state.height) * 0.6,
      );
      glow.addColorStop(0, "rgba(31, 58, 74, 0.16)");
      glow.addColorStop(0.42, "rgba(31, 25, 46, 0.08)");
      glow.addColorStop(1, "rgba(13, 9, 18, 0)");
      staticContext.fillStyle = glow;
      staticContext.fillRect(0, 0, state.width, state.height);

      for (const particle of state.particles) {
        const accent = clamp(particle.accent, 0, 1);
        const gray = Math.round(125 + particle.density * 64);
        const red = Math.round(gray * (1 - accent) + 68 * accent);
        const green = Math.round(gray * (1 - accent) + 166 * accent);
        const blue = Math.round(gray * (1 - accent) + 211 * accent);
        staticContext.fillStyle = `rgba(${red}, ${green}, ${blue}, ${particle.baseAlpha * 0.78})`;
        const size = Math.max(1, Math.round(particle.size * 0.86));
        staticContext.fillRect(
          Math.round(particle.baseX - size * 0.5),
          Math.round(particle.baseY - size * 0.5),
          size,
          size,
        );
      }
    }

    function resize() {
      state.staticDpr = Math.min(window.devicePixelRatio || 1, 1.25);
      state.width = window.innerWidth;
      state.height = window.innerHeight;
      const pixels = state.width * state.height;
      state.dynamicScale = pixels > 5_000_000 ? 0.68 : pixels > 2_800_000 ? 0.82 : 1;
      staticCanvas.width = Math.round(state.width * state.staticDpr);
      staticCanvas.height = Math.round(state.height * state.staticDpr);
      dynamicCanvas.width = Math.round(state.width * state.dynamicScale);
      dynamicCanvas.height = Math.round(state.height * state.dynamicScale);
      for (const canvas of [staticCanvas, dynamicCanvas]) {
        canvas.style.width = `${state.width}px`;
        canvas.style.height = `${state.height}px`;
      }
      staticContext.imageSmoothingEnabled = false;
      dynamicContext.imageSmoothingEnabled = false;
      buildParticles();
      drawStaticLayer();
      dynamicCanvas.dataset.dynamicParticles = String(state.dynamicParticles.length);
    }

    function triggerPulse(x, y) {
      state.pulse.x = x;
      state.pulse.y = y;
      state.pulse.startedAt = performance.now();
    }

    function updateParticle(particle, waves, time, delta) {
      const waveX =
        oscillateSin(waves.xSin, waves.xCos, particle.waveXPhase) * particle.drift;
      const waveY =
        oscillateCos(waves.ySin, waves.yCos, particle.waveYPhase) * particle.drift;
      let targetX = particle.baseX + waveX;
      let targetY = particle.baseY + waveY;
      const fieldWave =
        particle.fieldPhase.sin * waves.fieldCos -
        particle.fieldPhase.cos * waves.fieldSin;

      targetX += fieldWave * (0.5 + particle.density * 1.2);
      targetY += waveY * 0.24;
      let interactiveAccent = 0;

      if (state.pointer.active) {
        const dx = particle.x - state.pointer.x;
        const dy = particle.y - state.pointer.y;
        const distanceSquared = dx * dx + dy * dy;
        const radius = state.width < 700 ? 95 : 145;

        if (distanceSquared < radius * radius) {
          const distance = Math.sqrt(distanceSquared) || 0.001;
          const force = (1 - distance / radius) ** 2;
          targetX += (dx / distance) * force * 28;
          targetY += (dy / distance) * force * 28;
          interactiveAccent = force;
        }
      }

      const pulseAge = time - state.pulse.startedAt;
      if (pulseAge >= 0 && pulseAge < 1_250) {
        const dx = particle.x - state.pulse.x;
        const dy = particle.y - state.pulse.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const ringRadius = pulseAge * 0.34;
        const ringDistance = Math.abs(distance - ringRadius);
        const ringForce = Math.max(0, 1 - ringDistance / 42);
        const direction = pulseAge < 320 ? -1 : 1;
        targetX += (dx / distance) * ringForce * 24 * direction;
        targetY += (dy / distance) * ringForce * 24 * direction;
        interactiveAccent = Math.max(interactiveAccent, ringForce * 0.9);
      }

      const spring = reducedMotion ? 0.05 : 0.075;
      particle.vx += (targetX - particle.x) * spring * delta;
      particle.vy += (targetY - particle.y) * spring * delta;
      particle.vx *= Math.pow(0.84, delta);
      particle.vy *= Math.pow(0.84, delta);
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;

      return { fieldWave, interactiveAccent };
    }

    function render(time) {
      state.animationFrame = 0;
      if (state.disposed || !state.visible) return;
      const sinceLastFrame = time - state.lastFrame;
      if (sinceLastFrame + 0.2 < minimumFrameInterval) {
        state.animationFrame = window.requestAnimationFrame(render);
        return;
      }
      const elapsed = Math.min(34, sinceLastFrame);
      const delta = elapsed / 16.667;
      state.lastFrame = time - (sinceLastFrame % minimumFrameInterval);
      state.pointer.x += (state.pointer.targetX - state.pointer.x) * 0.16;
      state.pointer.y += (state.pointer.targetY - state.pointer.y) * 0.16;

      dynamicContext.setTransform(1, 0, 0, 1, 0, 0);
      dynamicContext.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);
      dynamicContext.setTransform(
        state.dynamicScale,
        0,
        0,
        state.dynamicScale,
        0,
        0,
      );
      const waves = {
        xSin: Math.sin(time * 0.00034),
        xCos: Math.cos(time * 0.00034),
        ySin: Math.sin(time * 0.00029),
        yCos: Math.cos(time * 0.00029),
        fieldSin: Math.sin(time * 0.00042),
        fieldCos: Math.cos(time * 0.00042),
        shimmerSin: Math.sin(time * 0.0011),
        shimmerCos: Math.cos(time * 0.0011),
        travelSin: Math.sin(time * 0.00105),
        travelCos: Math.cos(time * 0.00105),
      };
      for (const bucket of state.drawBuckets) bucket.length = 0;

      for (const particle of state.dynamicParticles) {
        const { fieldWave, interactiveAccent } = updateParticle(
          particle,
          waves,
          time,
          delta,
        );
        const shimmerWave = oscillateSin(
          waves.shimmerSin,
          waves.shimmerCos,
          particle.shimmerPhase,
        );
        const shimmer = 0.64 + 0.36 * (0.5 + 0.5 * shimmerWave);
        const travelWave =
          particle.travelPhase.sin * waves.travelCos -
          particle.travelPhase.cos * waves.travelSin;
        const travellingWave = 0.5 + 0.5 * travelWave;
        const accentMix = clamp(
          particle.accent * (0.38 + travellingWave * 0.72) +
            interactiveAccent * 0.92 +
            Math.max(0, fieldWave) * particle.accent * 0.16,
          0,
          1,
        );
        const alpha = clamp(
          particle.baseAlpha *
            shimmer *
            (0.78 + particle.density * 0.28) +
            interactiveAccent * 0.18,
          0.06,
          0.92,
        );
        particle.renderSize =
          particle.size * (0.82 + shimmer * 0.2 + interactiveAccent * 0.48);
        const brightness = alpha > 0.62 ? 2 : alpha > 0.38 ? 1 : 0;
        const accentBand =
          interactiveAccent > 0.16 || accentMix > 0.62
            ? 2
            : accentMix > 0.24
              ? 1
              : 0;
        const bucketIndex = Math.min(
          drawBucketStyles.length - 1,
          brightness + accentBand * 2 + (interactiveAccent > 0.4 ? 1 : 0),
        );
        state.drawBuckets[bucketIndex].push(particle);
      }

      for (let index = 0; index < state.drawBuckets.length; index += 1) {
        const bucket = state.drawBuckets[index];
        if (!bucket.length) continue;
        dynamicContext.fillStyle = drawBucketStyles[index];
        for (const particle of bucket) {
          const size = Math.max(1, Math.round(particle.renderSize));
          dynamicContext.fillRect(
            Math.round(particle.x - size * 0.5),
            Math.round(particle.y - size * 0.5),
            size,
            size,
          );
        }
      }

      if (!state.disposed && !reducedMotion && state.visible) {
        state.animationFrame = window.requestAnimationFrame(render);
      }
    }

    function handlePointerMove(event) {
      state.pointer.targetX = event.clientX;
      state.pointer.targetY = event.clientY;
      state.pointer.active = true;
    }

    function handlePointerLeave() {
      state.pointer.active = false;
      state.pointer.targetX = -9999;
      state.pointer.targetY = -9999;
    }

    function handlePointerDown(event) {
      if (event.target?.closest?.("button, a")) return;
      triggerPulse(event.clientX, event.clientY);
    }

    function handleResize() {
      window.clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(() => {
        if (state.disposed) return;
        resize();
        state.lastFrame = performance.now();
      }, 140);
    }

    function handleVisibilityChange() {
      state.visible = !document.hidden;
      if (!state.visible) {
        window.cancelAnimationFrame(state.animationFrame);
        state.animationFrame = 0;
        return;
      }
      state.lastFrame = performance.now();
      if (!reducedMotion && !state.animationFrame) {
        state.animationFrame = window.requestAnimationFrame(render);
      }
    }

    resize();
    if (!reducedMotion) {
      state.animationFrame = window.requestAnimationFrame(render);
    }
    const initialPulse = reducedMotion
      ? 0
      : window.setTimeout(
          () => triggerPulse(state.width * 0.58, state.height * 0.42),
          620,
        );

    window.addEventListener("resize", handleResize, { passive: true });
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave, {
      passive: true,
    });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      state.disposed = true;
      if (initialPulse) window.clearTimeout(initialPulse);
      window.clearTimeout(state.resizeTimer);
      window.cancelAnimationFrame(state.animationFrame);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <div className="welcome-particle-ocean" aria-hidden="true">
      <canvas ref={staticCanvasRef} className="welcome-particle-static" />
      <canvas ref={dynamicCanvasRef} className="welcome-particle-dynamic" />
    </div>
  );
}
