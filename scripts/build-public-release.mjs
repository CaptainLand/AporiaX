import { build, Platform, Arch } from "electron-builder";
import { readFile, copyFile, access, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const output = resolve(process.argv[2] || "release");
// electron-builder can omit transitive dependencies behind Windows junctions.
if ((await lstat("node_modules")).isSymbolicLink()) throw new Error("Release packaging requires a real node_modules directory, not a junction/symlink.");
await build({
  projectDir: process.cwd(),
  targets: Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64),
  publish: "never",
  config: { directories: { output } },
});
// Preview-named releases promoted to GitHub Latest use the ordinary updater.
const channel = pkg.version.includes("-") ? pkg.version.split("-")[1].split(".")[0] : "latest";
if (channel !== "latest") {
  try { await access(join(output, channel + ".yml")); await copyFile(join(output, channel + ".yml"), join(output, "latest.yml")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
await access(join(output, "latest.yml"));
const result = spawnSync(process.execPath, ["scripts/verify-windows-release.mjs", output], { stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exit(result.status || 1);
