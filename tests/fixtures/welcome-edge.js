import { mountGemSmoke } from "../../src/welcome/gem-smoke.js";
import "./welcome-edge.css";

window.edgeReady = new Promise((resolve, reject) => {
  window.disposeEdge = mountGemSmoke(document.querySelector("#sample"), {
    // Reproduce the old sampling path without editing production code back/forth.
    ...(new URLSearchParams(location.search).has("baseline") ? { mipmaps: [] } : {}),
    onReady: () => {
      const mount = document.querySelector("#sample").paperShaderMount;
      // Fixed animation time makes before/after edge comparisons meaningful.
      const setFrame = mount.setFrame;
      mount.setFrame = () => setFrame(1800);
      setFrame(1800);
      resolve();
    },
    onError: reject,
  });
});
