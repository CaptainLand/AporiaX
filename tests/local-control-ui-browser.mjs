import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const candidates = process.env.TEST_BROWSER ? [process.env.TEST_BROWSER] : [chromium.executablePath(),
  ...(process.platform === "win32" ? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"] : ["/usr/bin/chromium", "/usr/bin/chromium-browser"])];
const executablePath = candidates.find(path => existsSync(path));
if (!executablePath) throw new Error("Install a Playwright Chromium browser or set TEST_BROWSER before running local-control-ui-browser.mjs.");
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: process.env.TEST_BROWSER_ARGS ? JSON.parse(process.env.TEST_BROWSER_ARGS) : [] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const url = server.resolvedUrls.local[0] + "tests/fixtures/local-control.html";
  const navigate = async target => {
    await page.goto(target);
    if (process.env.TEST_FONT_CSS) {
      await page.addStyleTag({ url: new URL(process.env.TEST_FONT_CSS, server.resolvedUrls.local[0]).href });
      await page.addStyleTag({ content: '.external-control-panel { font-family: "Noto Sans SC", sans-serif; }' });
      await page.evaluate(() => document.fonts.ready);
    }
  };
  await navigate(url);
  const dialog = page.getByRole("dialog", { name: "外部连接", exact: true });
  await dialog.getByRole("switch", { name: "启用外部连接" }).waitFor();
  assert.equal(await dialog.getByRole("switch").getAttribute("aria-checked"), "false");
  await dialog.getByRole("switch").click();
  await page.waitForFunction(() => window.localControlFixture.state.enabled);
  await dialog.getByRole("heading", { name: "AporiaX 工作区" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "选择目录并授权" }).count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "全局文件权限" }).count(), 0);
  await dialog.getByLabel("连接名称", { exact: true }).fill("Codex");
  await dialog.locator(".control-create").getByLabel("Aporia Cloud", { exact: false }).check();
  await dialog.getByLabel("Fixture provider", { exact: true }).check();
  await dialog.getByText("能力与运行限额", { exact: true }).click();
  await dialog.getByLabel("模型调用次数", { exact: true }).fill("0");
  await dialog.getByLabel("子代理总数", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "创建并获取连接配置" }).click();
  await dialog.getByRole("heading", { name: "连接已创建" }).waitFor();
  const issued = dialog.getByRole("region", { name: "连接凭据" });
  await issued.getByRole("button", { name: "复制配置", exact: true }).click();
  assert.match(await page.evaluate(() => window.localControlFixture.copied[0]), /mcpServers/);
  await issued.getByRole("button", { name: "Codex TOML" }).click();
  await issued.getByRole("button", { name: "复制配置", exact: true }).click();
  assert.match(await page.evaluate(() => window.localControlFixture.copied.at(-1)), /\[mcp_servers\.aporiax\]/);
  await issued.getByText("查看本地 API 地址和密钥", { exact: true }).click();
  assert.equal(await issued.getByLabel("API 密钥", { exact: true }).inputValue(), "fixture-credential-only");
  await mkdir(".tmp/local-control-ui", { recursive: true });
  await page.screenshot({ path: ".tmp/local-control-ui/paired-connection.png" });
  const grant = await page.evaluate(() => window.localControlFixture.calls.find(call => call.action === "createClient").input);
  assert.deepEqual(grant.workspaceIds, ["ws-fixture"]);
  assert.equal(await page.evaluate(() => window.localControlFixture.calls.some(call => ["registerWorkspace", "removeWorkspace"].includes(call.action))), false);
  assert.deepEqual(grant.providerIds, ["provider-fixture"]);
  assert.equal(grant.limits.maxModelCalls, 0);
  assert.equal(grant.limits.maxSubagents, 0);
  assert.deepEqual(grant.capabilities, { commands: false, browser: false, mcp: false });
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-credential-only")), false);
  await dialog.getByRole("button", { name: "关闭外部连接", exact: true }).click();
  await page.getByRole("button", { name: "Open external connections", exact: true }).click();
  await dialog.getByRole("heading", { name: "已配对的客户端" }).waitFor();
  assert.equal(await dialog.getByRole("region", { name: "连接凭据" }).count(), 0);
  assert.equal(await dialog.locator('input[value="fixture-credential-only"]').count(), 0);

  // A task arrives without any GUI-created task/run records. The panel must
  // discover it through the server and allow local questions and approvals.
  await page.evaluate(() => window.localControlFixture.addRun());
  await dialog.getByRole("button", { name: /^外部任务/ }).click();
  await dialog.getByRole("heading", { name: "检查鉴权与计费并生成修复补丁" }).waitFor();
  await dialog.getByText("独立工作区交付", { exact: true }).waitFor();
  await dialog.getByText("D:/AporiaX/runs/run-external/workspace", { exact: true }).first().waitFor();
  await dialog.getByRole("button", { name: "打开执行目录", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.localControlFixture.openedWorkspaces), ["D:/AporiaX/runs/run-external/workspace"]);
  await page.screenshot({ path: ".tmp/local-control-ui/tasks-pending-zh-light.png" });
  await dialog.getByRole("button", { name: "暂停任务", exact: true }).click();
  await dialog.getByRole("button", { name: "继续任务", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => window.localControlFixture.state.runs[0].status === "paused");
  await dialog.getByRole("button", { name: "继续任务", exact: true }).click();
  await dialog.getByLabel("你的回答", { exact: true }).fill("使用预发布环境，仅使用测试数据。");
  await dialog.getByRole("button", { name: "回答并继续", exact: true }).click();
  await dialog.getByText("使用预发布环境，仅使用测试数据。", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "批准这一次", exact: true }).click();
  await page.waitForFunction(() => window.localControlFixture.calls.some(call => call.action === "respondApproval"));
  const approval = await page.evaluate(() => window.localControlFixture.calls.find(call => call.action === "respondApproval").input);
  assert.deepEqual(approval, { runId: "run-external", approvalId: "approval-fixture", approved: true, scope: "once" });
  await dialog.getByLabel("追加指导", { exact: true }).fill("保留已有的未提交修改。");
  await dialog.getByRole("button", { name: "发送到任务", exact: true }).click();
  await page.waitForFunction(() => window.localControlFixture.calls.some(call => call.action === "sendMessage"));
  await dialog.getByText("完整结果、修改与验证", { exact: true }).click();
  await dialog.getByText("changes.patch", { exact: true }).waitFor();
  await dialog.getByText("reviewer", { exact: true }).waitFor();
  const events = dialog.locator(".control-events");
  await events.locator("li").first().waitFor();
  if (await dialog.getByRole("button", { name: "读取更多事件" }).isVisible()) await dialog.getByRole("button", { name: "读取更多事件" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".control-events li").length >= 200);
  const seqs = await events.locator("summary > code").allTextContents();
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(seqs[0], "#1");
  await mkdir(".tmp/local-control-ui", { recursive: true });
  await dialog.locator(".control-run-detail").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: ".tmp/local-control-ui/tasks-zh-light.png" });
  await dialog.getByRole("button", { name: "停止任务", exact: true }).click();
  await page.waitForFunction(() => window.localControlFixture.state.runs[0].status === "cancelled");

  await dialog.getByRole("button", { name: "连接管理", exact: true }).click();
  await page.evaluate(() => window.localControlFixture.rejectNext("revokeClient", "The local service is temporarily unavailable."));
  await dialog.getByRole("button", { name: "撤销连接", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "temporarily unavailable" }).waitFor();
  await dialog.getByRole("button", { name: "撤销连接", exact: true }).click();
  await dialog.getByText("已撤销", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭外部连接", exact: true }).click();
  await page.evaluate(() => window.localControlFixture.openRun("run-external"));
  await dialog.getByRole("heading", { name: "检查鉴权与计费并生成修复补丁" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);

  // Global native file authority is independent of the local listener toggle.
  await page.evaluate(() => { window.localControlFixture.state.enabled = false; });
  const permissionsEntry = page.locator(".settings-section").filter({ has: page.locator('[aria-label="命令执行模式"]') }).getByRole("button", { name: "全局文件权限", exact: true });
  await permissionsEntry.click();
  const permissions = page.getByRole("dialog", { name: "全局文件权限", exact: true });
  const fileSwitch = permissions.getByRole("switch", { name: "允许访问工作区外文件", exact: true });
  await fileSwitch.waitFor();
  assert.equal(await fileSwitch.getAttribute("aria-checked"), "false");
  await fileSwitch.click();
  await permissions.getByRole("group", { name: "确认全局文件访问风险" }).waitFor();
  assert.equal(await page.evaluate(() => window.localControlFixture.calls.filter(call => call.action === "setFileAccess").length), 0);
  await permissions.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await fileSwitch.getAttribute("aria-checked"), "false");
  await fileSwitch.click();
  await page.screenshot({ path: ".tmp/local-control-ui/global-file-risk-zh.png" });
  await page.evaluate(() => window.localControlFixture.rejectNext("setFileAccess", "Cannot save permission setting."));
  await permissions.getByRole("button", { name: "我了解风险，开启全局权限", exact: true }).click();
  await permissions.getByRole("alert").filter({ hasText: "Cannot save" }).waitFor();
  assert.equal(await fileSwitch.getAttribute("aria-checked"), "false");
  await permissions.getByRole("button", { name: "我了解风险，开启全局权限", exact: true }).click();
  await page.waitForFunction(() => window.localControlFixture.state.fileAccess.enabled);
  assert.deepEqual(await page.evaluate(() => window.localControlFixture.calls.find(call => call.action === "setFileAccess").input), { enabled: true, riskAcknowledged: true });
  await fileSwitch.click();
  await page.waitForFunction(() => !window.localControlFixture.state.fileAccess.enabled);
  assert.equal(await page.evaluate(() => window.localControlFixture.state.enabled), false);
  await page.keyboard.press("Escape");
  assert.equal(await permissions.count(), 0);
  assert.equal(await permissionsEntry.evaluate(element => element === document.activeElement), true);
  await permissionsEntry.click();
  await fileSwitch.waitFor();
  assert.equal(await fileSwitch.getAttribute("aria-checked"), "false");

  // Check both desktop themes/languages and a small viewport for clipped forms.
  for (const [lang, theme, width] of [["en", "dark", 1100], ["zh-CN", "light", 880], ["en", "light", 620]]) {
    await page.setViewportSize({ width, height: 780 });
    await navigate(`${url}?lang=${lang}&theme=${theme}`);
    await page.getByRole("dialog").getByRole("switch").waitFor();
    const overflow = await page.locator(".external-control-panel").evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    assert(overflow.scroll <= overflow.client + 1, JSON.stringify({ lang, theme, width, ...overflow }));
    await page.screenshot({ path: `.tmp/local-control-ui/connections-${lang}-${theme}-${width}.png` });
    await page.getByRole("button", { name: lang === "en" ? "Close external connections" : "关闭外部连接", exact: true }).click();
    await page.getByRole("button", { name: lang === "en" ? "Global file permissions" : "全局文件权限", exact: true }).click();
    await page.getByRole("dialog").getByRole("switch").click();
    const permissionsOverflow = await page.locator(".external-control-panel").evaluate(element => element.scrollWidth - element.clientWidth);
    assert(permissionsOverflow <= 1);
    await page.screenshot({ path: `.tmp/local-control-ui/global-file-${lang}-${theme}-${width}.png` });
  }
  await navigate(`${url}?empty=1`);
  await dialog.getByText(/暂无可用工作区/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "创建并获取连接配置" }).isDisabled(), true);
  await navigate(`${url}?unavailable=1`);
  await page.getByRole("alert").filter({ hasText: "新版 AporiaX 桌面端" }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log("Local control React UI: pairing, workspace/provider grants, zero limits, copy configs, one-time credential lifecycle, external task discovery, pause/resume/cancel, guidance, question, human approval, event pagination, result/worktree disclosure, revoke failure/retry, notification navigation, languages/themes/layout: PASS (simulated IPC backend, real Chromium)");
} finally {
  await browser?.close();
  await server.close();
}
