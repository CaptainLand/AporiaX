import { build, Platform, Arch } from "electron-builder";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const web = resolve(root, ".tmp/aporiax-web-guide");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const output = resolve(root, process.argv[2] || `release/v${pkg.version}-oneclick`);
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error("Private preview build failed");
}
if (!existsSync(join(web, "node_modules/vite/bin/vite.js"))) throw new Error("Build requires the current Web checkout and its dependencies");
run(["node_modules/vite/bin/vite.js", "build", "--mode", "private-preview", "--outDir", ".tmp/private-preview-web"], web);
run(["node_modules/vite/bin/vite.js", "build"], root);
await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64), publish: "never",
  config: { ...pkg.build, directories: { ...pkg.build.directories, output },
    extraResources: [{ from: join(web, ".tmp/private-preview-web"), to: "private-cloud-web", filter: ["**/*", "!**/.env*", "!**/*.map"] }],
  },
});
run(["scripts/verify-windows-release.mjs", output], root);
