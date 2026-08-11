import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostFallbackCommand } from "../electron/sandbox-runtime.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "aporiax-watchdog-"));
const notices = [];
const startedAt = Date.now();
try {
  const escapedNode = process.execPath.replace(/"/g, '\\"');
  const command = process.platform === "win32"
    ? "for /L %i in (1,0,2) do @rem"
    : `"${escapedNode}" -e "setInterval(() => {}, 1000)"`;
  const result = await runHostFallbackCommand({
    command,
    workspaceRoot,
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    timeoutMs: 180,
    watchdogSlowMs: 40,
    onWatchdog: (notice) => notices.push(notice),
    sandboxStatus: { detail: "watchdog smoke" },
  });
  assert.equal(result.timedOut, true);
  assert(notices.some((notice) => notice.stage === "slow"));
  assert(notices.some((notice) => notice.stage === "intervention"));
  assert(result.watchdogEvents.some((notice) => notice.stage === "intervention"));
  assert(Date.now() - startedAt < 6_000, "process tree timeout must settle promptly");
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("sandbox watchdog smoke: PASS");
