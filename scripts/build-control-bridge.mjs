import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  absWorkingDir: root,
  entryPoints: ["electron/control/bridge/entry.js"],
  outfile: "build/control-bridge.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "eof",
  logLevel: "warning",
});
process.stdout.write("Built build/control-bridge.cjs (MCP + CLI, no external Node packages required).\n");
