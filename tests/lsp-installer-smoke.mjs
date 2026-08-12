import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "aporiax-lsp-install-smoke-"));
process.env.APORIAX_LSP_HOME = home;
const {
  describeLanguageServers,
  getLanguageServerHome,
  getLanguageServerInstallPlan,
} = await import("../electron/runtime/lsp-installer.js?smoke=" + Date.now());

try {
  assert.equal(getLanguageServerHome(), home);
  const python = getLanguageServerInstallPlan("python");
  assert.equal(python.language, "python");
  assert.equal(python.installer, "npm");
  assert.equal(python.managed, true);
  assert.ok(python.args.includes("pyright@latest"));

  const go = getLanguageServerInstallPlan("go");
  assert.equal(go.installer, "go");
  assert.equal(go.managed, true);
  assert.match(go.env.GOBIN, /language|lsp|go|aporiax/i);

  const rust = getLanguageServerInstallPlan("rust");
  assert.equal(rust.installer, "rustup");

  const clangd = getLanguageServerInstallPlan("clangd");
  assert.ok(["winget", "brew", "apt-get"].includes(clangd.installer));

  const status = describeLanguageServers();
  assert.equal(status.length, 4);
  assert.ok(status.every((item) => item.installable));
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log("lsp installer smoke: PASS");
