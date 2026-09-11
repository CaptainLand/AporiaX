import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Paper ShaderMount (Apache-2.0) injects an inline stylesheet. Desktop CSP is
// style-src 'self', so the injection is stripped at build time. Canvas rules
// live in src/welcome/welcome.css. This is not a vendor fork of the package.
function paperShaderCsp() {
  return {
    name: "paper-shader-csp",
    transform(code, id) {
      const path = id.replace(/\\/g, "/");
      if (!path.includes("/@paper-design/shaders/") || !code.includes("head.prepend(styleElement)")) {
        return null;
      }
      const next = code.replace(
        /if \(!this\.ownerDocument\.querySelector\("style\[data-paper-shader\]"\)\) \{[\s\S]*?this\.ownerDocument\.head\.prepend\(styleElement\);\r?\n\s*\}/,
        "/* Paper canvas CSS is in welcome.css; inline injection is omitted for CSP. */",
      );
      if (next === code) {
        throw new Error("paper-shader-csp: ShaderMount style injection was not stripped");
      }
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), paperShaderCsp()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
