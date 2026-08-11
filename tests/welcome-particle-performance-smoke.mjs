import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const particleSource = await readFile(
  new URL("../src/WelcomeParticleOcean.jsx", import.meta.url),
  "utf8",
);
const rendererSource = await readFile(
  new URL("../src/main.jsx", import.meta.url),
  "utf8",
);

assert.match(particleSource, /const maximumFps = 120/);
assert.match(particleSource, /function buildFieldMap\(/);
assert.match(particleSource, /function sampleField\(/);
assert.match(particleSource, /state\.dynamicParticles = \[\.\.\.particles\]/);
assert.match(particleSource, /1_250/);
assert.match(particleSource, /drawStaticLayer\(\)/);
assert.match(particleSource, /visibilitychange/);
assert.match(particleSource, /welcome-particle-static/);
assert.match(particleSource, /welcome-particle-dynamic/);
assert.doesNotMatch(
  particleSource,
  /for \(const particle of state\.particles\) \{\s*const \{ fieldWave, interactiveAccent \} = updateParticle/s,
  "the animation loop must not update the full static particle field",
);
assert.match(
  rendererSource,
  /\{!welcomeOpen && <div className="app-content">/,
  "the full task workspace must remain unmounted behind the welcome animation",
);

console.log("welcome particle performance smoke: PASS");
