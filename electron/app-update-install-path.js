import { win32 } from "node:path";

// NSIS otherwise follows the last registered installation (or its C: default),
// which need not be the copy the user is currently running. Never accept an
// installation target from renderer input, update metadata or the working dir.
export function updateInstallDirectory({ channel, platform, execPath } = {}) {
  if (channel !== "nsis" || platform !== "win32") return undefined;
  if (typeof execPath !== "string" || /[\x00-\x1f"<>|?*]/.test(execPath) ||
      !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(execPath) ||
      win32.extname(execPath).toLowerCase() !== ".exe") {
    throw new Error("INVALID_UPDATE_INSTALL_DIRECTORY");
  }
  const directory = win32.dirname(win32.normalize(execPath));
  if (directory === win32.parse(directory).root) {
    throw new Error("INVALID_UPDATE_INSTALL_DIRECTORY");
  }
  return directory;
}
