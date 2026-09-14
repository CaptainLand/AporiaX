import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { createWorkbenchGitService, runWorkbenchGit } from "../electron/workbench/git-service.js";
import { verifyExistingTarget } from "../electron/runtime/workspace-runtime.js";

const base = await mkdtemp(join(tmpdir(), "aporiax-git-setup-ui-")), root = join(base, "project"), empty = join(base, "empty"), cloned = join(base, "cloned"), bare = join(base, "remote.git");
for (const path of [root, empty, cloned, bare]) await mkdir(path);
await mkdir(".tmp/workbench-git-v2", { recursive: true });
const git = async (cwd, args) => { const value = await runWorkbenchGit(cwd, args); assert.equal(value.code, 0, value.stderr); return value.stdout.trim(); };
await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Fixture"]); await git(root, ["config", "user.email", "fixture@example.invalid"]);
await git(root, ["config", "commit.gpgsign", "false"]); const hooks = join(base, "hooks"); await mkdir(hooks); await git(root, ["config", "core.hooksPath", hooks]);
await writeFile(join(root, "note.txt"), "initial\n"); await git(root, ["add", "--", "note.txt"]); await git(root, ["commit", "-m", "Initial fixture"]);
await git(bare, ["init", "--bare", "-b", "main"]); await git(root, ["push", bare, "main"]);
let authenticated = false, confirmations = 0;
const service = createWorkbenchGitService({ confirmPush: async () => { confirmations++; return true; }, confirmOperation: async () => { confirmations++; return true; },
  runGit: (cwd, args, options) => runWorkbenchGit(cwd, args[0] === "clone" ? ["clone", "--", bare, "."] : args, options),
  runGitHub: async ({ cwd, args }) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: JSON.stringify(authenticated ? [{ login: "fixture", active: true, state: "success", token: "SECRET_NOT_FOR_UI" }] : []), stderr: "" };
    assert.equal(args[0], "repo"); assert.equal(args[1], "create"); assert.ok(args.includes("--private")); assert.ok(!args.includes("--push"));
    await git(cwd, ["remote", "add", args.at(-1), "https://github.com/fixture/browser-repo.git"]);
    return { exitCode: 0, stdout: "created", stderr: "" };
  } });
const server = await createServer({ server: { host: "127.0.0.1", port: 0, watch: null }, plugins: [{ name: "git-setup-fixture", configureServer(dev) {
  dev.middlewares.use("/__fixture/meta", (req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "git-v2", workspacePath: req.url.includes("empty") ? empty : req.url.includes("clone") ? cloned : root })); });
  dev.middlewares.use("/__fixture/request", async (req, res) => {
    try {
      let text = ""; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text), cwd = input.workspacePath; let value = true;
      assert.ok([root, empty, cloned].includes(cwd));
      if (input.action === "git") value = await service.request(input);
      else if (input.action === "list") value = [];
      else if (input.action === "preview") value = { content: await readFile(await verifyExistingTarget(cwd, input.path), "utf8") };
      else if (input.action === "save") { await writeFile(await verifyExistingTarget(cwd, input.requestedPath), input.content); value = { content: input.content }; }
      else if (input.action === "github-login") { authenticated = true; value = { id: "fixture-login", taskId: input.taskId, workspacePath: cwd, kind: "terminal", title: "GitHub 登录", status: "running", owner: "user" }; }
      else if (input.action === "read") value = { id: input.id, kind: "terminal", status: "running", output: input.cursor ? "" : "Mock browser authorization completed\r\n", cursor: 100 };
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
} }] });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1150, height: 850 } }), errors = [], outgoing = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => { if (!req.url().startsWith(server.resolvedUrls.local[0])) outgoing.push(req.url()); });
  const url = server.resolvedUrls.local[0] + "tests/fixtures/workbench-git-setup.html";
  const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
  const dialog = page.getByRole("dialog");
  await page.goto(url); await page.locator(".workbench-empty-card").nth(5).click();
  await button("选择 Git 分支").click(); await page.getByLabel("新分支名称", { exact: true }).fill("feature/browser"); await button("创建并切换").click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]") && document.querySelector(".git-branch-trigger")?.textContent.includes("feature/browser"));
  await page.evaluate(() => window.wb.openFile("note.txt")); await button("编辑").click(); await page.getByLabel("代码编辑器").fill("unsaved draft");
  await page.evaluate(() => window.wb.open("git")); await button("选择 Git 分支").click(); assert.equal(await button("main", dialog).isDisabled(), true);
  await button("关闭弹窗").click(); await page.evaluate(() => window.wb.select("file:note.txt")); await button("保存").click(); await page.waitForFunction(() => window.wb.dirty.current.size === 0);
  await page.evaluate(() => window.wb.open("git")); await button("选择 Git 分支").click(); await button("main", dialog).click(); await dialog.getByRole("alert").filter({ hasText: "未提交" }).waitFor(); await page.keyboard.press("Escape");
  await button("暂存 note.txt").click(); await button("取消暂存 note.txt").waitFor(); await page.getByLabel("提交说明", { exact: true }).fill("UI branch change"); await button("提交已暂存").click(); await page.waitForFunction(() => document.querySelector(".git-commit textarea")?.value === "");
  await button("选择 Git 分支").click(); await page.screenshot({ path: ".tmp/workbench-git-v2/branches-light.png" }); await button("main", dialog).click(); await dialog.waitFor({ state: "detached" });
  await button("仓库设置").click(); await button("提交身份", dialog).click(); await page.getByLabel("提交者姓名", { exact: true }).fill("UI Fixture"); await page.getByLabel("提交者邮箱", { exact: true }).fill("ui@example.invalid"); await button("保存提交身份").click();
  await page.waitForFunction(() => !document.querySelector('dialog [role="status"]')); assert.equal(await git(root, ["config", "--local", "user.name"]), "UI Fixture");
  await button("远程", dialog).click(); await page.getByLabel("仓库地址", { exact: true }).fill("https://github.com/fixture/existing.git"); await button("保存远程关联").click(); await dialog.getByText("https://github.com/fixture/existing.git", { exact: true }).waitFor();
  await button("GitHub", dialog).click(); await button("浏览器登录", dialog).waitFor(); await button("浏览器登录", dialog).click(); await dialog.waitFor({ state: "detached" });
  assert.ok(await page.evaluate(() => window.calls.some((call) => call.action === "github-login")));
  await page.evaluate(() => window.wb.open("git")); await button("仓库设置").click(); await button("GitHub", dialog).click(); await dialog.getByText("GitHub 已登录", { exact: true }).waitFor();
  await page.getByLabel("用户名 / 仓库名", { exact: true }).fill("fixture/browser-repo"); await page.getByLabel("关联远程名称", { exact: true }).fill("github");
  assert.equal(await button("私有", dialog).getAttribute("aria-pressed"), "true");
  assert.equal(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
  await button("创建并关联").scrollIntoViewIfNeeded(); await page.screenshot({ path: ".tmp/workbench-git-v2/github-light.png" });
  await button("创建并关联").click(); await dialog.getByText("此远程名称已存在，请使用其他名称，或直接向已有远程发布分支。", { exact: true }).waitFor();
  assert.equal(await git(root, ["remote", "get-url", "github"]), "https://github.com/fixture/browser-repo.git"); assert.ok(!await page.locator("body").innerText().then((text) => text.includes("SECRET_NOT_FOR_UI")));
  await page.keyboard.press("Escape");
  await git(root, ["remote", "add", "offline", bare]); await button("刷新 Git").click(); await page.waitForFunction(() => !document.querySelector('.git-operation'));
  await button("发布分支").click(); await button("offline", dialog).click(); await page.getByLabel("远程分支名称", { exact: true }).fill("preview"); await button("确认发布目标").click(); await dialog.waitFor({ state: "detached" });
  assert.equal(await git(root, ["rev-parse", "--abbrev-ref", "@{u}"]), "offline/preview");
  await page.setViewportSize({ width: 820, height: 720 }); await page.evaluate(() => document.documentElement.dataset.theme = "dark"); await button("仓库设置").click();
  await dialog.locator(".git-remote-list button").first().waitFor();
  assert.equal(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(33, 29, 41)");
  await button("保存远程关联").scrollIntoViewIfNeeded(); await page.screenshot({ path: ".tmp/workbench-git-v2/remotes-dark-narrow.png" });
  assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true); await button("关闭弹窗").click();

  await page.goto(url + "?empty=1"); await page.locator(".workbench-empty-card").nth(5).click(); await button("初始化仓库").click(); await button("初始化当前工作区").click(); await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector('.git-branch-trigger')?.textContent.includes("main")); assert.match(await readFile(join(empty, ".gitignore"), "utf8"), /node_modules/);
  await page.goto(url + "?clone=1"); await page.locator(".workbench-empty-card").nth(5).click(); await button("克隆仓库").click(); await page.getByLabel("仓库地址", { exact: true }).fill("https://example.invalid/clone.git"); await button("克隆到当前工作区").click(); await dialog.waitFor({ state: "detached" });
  assert.equal((await readFile(join(cloned, "note.txt"), "utf8")).replace(/\r\n/g, "\n"), "initial\n");
  assert.ok(confirmations >= 3); assert.deepEqual(errors, []); assert.deepEqual(outgoing, []);
  console.log("PASS: browser Git v2: branch create/switch, unsaved and dirty guards, identity/remote forms, mocked login terminal routing and private repo creation, real local first push/upstream, initialize/clone, close/Esc, narrow dark modal; no external requests.");
} finally { await browser?.close(); await server.close(); }
