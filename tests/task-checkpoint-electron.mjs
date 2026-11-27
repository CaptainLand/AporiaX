import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { _electron } from "playwright-core";

const temp = resolve(tmpdir());
const profile = await mkdtemp(join(temp, "aporiax-checkpoint-electron-"));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) {
  if (/^(?:APORIAX_|PORTABLE_)/.test(key) || ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DEEPSEEK_API_KEY"].includes(key)) delete env[key];
}
const history = join(profile, "aporiax-store");
const index = () => readFile(join(history, "index.json"), "utf8");
async function waitForSaved(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("task change did not become durable");
}
const task = id => ({
  id, title: id, workspacePath: "", workspaceName: "Fixture", projectId: "workspace:unbound",
  messages: [{ id: id + "-message", role: "user", content: id + " content" }],
});
let app;
try {
  app = await _electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [resolve("."), "--user-data-dir=" + profile, "--disable-gpu"], env, timeout: 30_000,
  });
  const actualProfile = await app.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(resolve(actualProfile), profile, "never use the real task profile");
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop?.tasks?.patch));
  await page.evaluate(async seeds => {
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ taskId: "active", welcomeDismissed: true }));
    await window.desktop.tasks.load();
    await window.desktop.tasks.save(seeds);
  }, [task("active"), task("unrelated"), task("remove")]);
  const originalIndex = await index();
  const originalUnrelated = await readFile(join(history, "tasks", "unrelated.json"), "utf8");
  await page.reload();
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  await page.locator('.task-item[title="active"]').waitFor();
  await page.waitForTimeout(900); // No autosave on an unchanged startup.
  assert.equal(await index(), originalIndex);
  await page.locator('.task-item[title="active"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名任务" }).click();
  await page.locator("#rename-task-title").fill("updated");
  await page.locator(".rename-task-modal").getByRole("button", { name: "保存" }).click();
  await waitForSaved(async () => JSON.parse(await readFile(join(history, "tasks", "active.json"), "utf8")).title === "updated");
  await page.locator('.task-item[title="remove"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除任务" }).click();
  await page.locator(".delete-task-confirm").click();
  await waitForSaved(async () => !JSON.parse(await index()).taskIds.includes("remove"));
  const { revision } = JSON.parse(await index());
  await page.reload();
  const reloaded = await page.evaluate(async () => window.desktop.tasks.load());
  assert.deepEqual(reloaded.map(({ id, title }) => [id, title]), [["active", "updated"], ["unrelated", "unrelated"]]);
  assert.equal(await readFile(join(history, "tasks", "unrelated.json"), "utf8"), originalUnrelated);
  assert.match(await readFile(join(history, "deleted", `remove.${revision}.json`), "utf8"), /"id":"remove"/);
  assert.deepEqual(errors, []);
  console.log("PASS real desktop IPC: no startup write, one-task patch, explicit archival and reload.");
} finally {
  await app?.close();
  if (dirname(profile) === temp && basename(profile).startsWith("aporiax-checkpoint-electron-")) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
