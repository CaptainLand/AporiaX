import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, preview } from "vite";
import { chromium } from "playwright-core";
import { createAporiaCloudProvider } from "../electron/provider-config.js";

const baseline = process.env.ONBOARDING_BASELINE_ROOT;
const production = process.env.ONBOARDING_PRODUCTION === "1";
const server = production
  ? await preview({ preview: { host: "127.0.0.1", port: 0, open: false } })
  : await createServer({ ...(baseline ? { root: baseline } : {}), server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
let browser;
try {
  if (!production) await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  // Vite dev injects CSS inline; the packaged app uses external CSS under its
  // strict CSP. Relax CSP only in this mocked dev test, never in app code.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, bypassCSP: !production });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.addInitScript((cloud) => {
    localStorage.clear();
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ welcomeDismissed: true }));
    const signedIn = { status: "authenticated", profile: { displayName: "测试账号", email: "test@example.invalid" }, quota: { remainingRatio: .8 }, models: cloud.models, device: { remoteEnabled: false } };
    window.fixture = { providers: [cloud], calls: [], savedTasks: [], loginMode: "success", account: { status: "anonymous" } };
    const state = window.fixture;
    window.desktop = {
      theme: { set: async () => {} },
      providers: {
        list: async () => state.providers,
        save: async (input) => { state.calls.push({ type: "save", input }); const saved = { ...input, id: "own-api", vendor: "custom", source: "user-provider", models: input.models.map((model) => ({ ...model, name: model.name || model.id, shortName: model.shortName || model.id, supportsTools: true })) }; state.providers = [cloud, saved]; return saved; },
      },
      account: {
        get: async () => state.account,
        signIn: async () => { state.calls.push({ type: "signIn" }); if (state.loginMode === "cancel") return { canceled: true }; if (state.loginMode === "error") throw new Error("NETWORK_UNAVAILABLE"); state.account = signedIn; return signedIn; },
        signOut: async () => (state.account = { status: "anonymous" }),
        refresh: async () => state.account,
      },
      tasks: { load: async () => [], save: async (tasks) => { state.savedTasks = tasks; } },
      harness: { run: async (input) => { state.calls.push({ type: "run", input }); return { content: "完成", status: "completed", steps: [], changes: [], route: [] }; }, onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { request: async ({ action }) => action === "list" ? [] : true, subscribe: () => () => {} },
      sideChat: { request: async ({ action }) => action === "load" ? { messages: [] } : {}, subscribe: () => () => {} },
    };
  }, createAporiaCloudProvider());
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  await page.locator(".local-account-signin:not(:disabled)").waitFor();
  await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
  await page.locator("#task-title").fill("首次使用测试");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await page.locator(".model-trigger").first().click();
  const choices = page.locator(".model-menu .model-choice");
  assert.equal(await page.locator(".model-menu").evaluate((el) => getComputedStyle(el).position), "absolute", "Require real app styles for visual checks");
  if (baseline) {
    assert.equal(await choices.count(), 2);
    assert.equal(await choices.first().isDisabled(), false);
    assert.equal(await page.locator(".model-menu .model-choice.selected").count(), 1);
    console.log("REPRODUCED 0.9.9 baseline: anonymous new task auto-selects Cloud and both Cloud models are enabled.");
  } else {
    assert.equal(await choices.count(), 2);
    assert.equal(await choices.first().isDisabled(), true);
    assert.equal(await choices.last().isDisabled(), true);
    assert.equal(await page.locator(".model-menu .model-choice.selected").count(), 0);
    await page.keyboard.press("Escape");
    const draft = page.getByRole("textbox", { name: "任务输入", exact: true });
    await draft.fill("登录和配置之前保留这段草稿");
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
    await draft.press("Enter");
    await choices.first().waitFor();
    assert.equal(await draft.inputValue(), "登录和配置之前保留这段草稿");
    assert.equal(await page.evaluate(() => window.fixture.calls.filter((c) => c.type === "run").length), 0);
    await page.evaluate(() => { window.fixture.loginMode = "cancel"; });
    await page.getByRole("button", { name: "登录 Aporia Cloud", exact: true }).click();
    assert.equal(await choices.first().isDisabled(), true);
    await page.evaluate(() => { window.fixture.loginMode = "error"; });
    await page.getByRole("button", { name: "登录 Aporia Cloud", exact: true }).click();
    await page.locator(".model-menu [role=alert]").waitFor();
    assert.equal(await choices.first().isDisabled(), true);
    await page.getByRole("button", { name: "添加自己的 API", exact: true }).click();
    await page.locator(".provider-editor").waitFor();
    assert.equal(await page.locator(".provider-list").getByRole("button", { name: /Aporia Cloud/ }).count(), 0, "Managed Cloud must not enter the API editor");
    assert.equal(await page.getByLabel("API Base URL", { exact: true }).inputValue(), "", "Add API opens a blank form");
    await page.getByLabel("名称（可选）", { exact: true }).fill("自己的 API");
    await page.getByLabel("API Base URL", { exact: true }).fill("https://example.invalid/v1");
    await page.locator(".provider-models-input").fill("own-model");
    await page.locator(".provider-manager-modal button[type=submit]").click();
    await page.waitForFunction(() => window.fixture.calls.some((c) => c.type === "save"));
    await page.locator(".application-settings-header button[aria-label]").last().click();
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    assert.equal(await choices.first().isDisabled(), true);
    await page.locator(".model-menu .model-choice").filter({ hasText: "own-model" }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), false);
    assert.equal(await draft.inputValue(), "登录和配置之前保留这段草稿");
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.evaluate(() => { window.fixture.loginMode = "success"; });
    await page.getByRole("button", { name: "登录 Aporia Cloud", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".model-menu .model-choice").disabled);
    assert.equal(await choices.first().isDisabled(), false);
    assert.equal(await choices.nth(1).isDisabled(), false);
    assert.match(await page.locator(".model-choice.selected").innerText(), /own-model/, "Login must not change a custom selection");
    await choices.first().click();
    await page.keyboard.press("Escape");
    // A successful login is independent from a usable server model catalog.
    const refreshAccount = async () => {
      await page.locator(".local-account-profile").click();
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".local-account-actions button").disabled);
      assert.equal(await page.locator(".local-account-remote").first().isDisabled(), true);
      await page.locator(".local-account-profile").click();
      await page.getByRole("button", { name: "选择模型", exact: true }).click();
    };
    await page.evaluate(() => { window.fixture.catalog = window.fixture.account.models; window.fixture.account = { ...window.fixture.account, models: [], capabilities: { remote: { supported: false } } }; });
    await refreshAccount();
    assert.equal(await choices.first().isDisabled(), true, "Empty server catalog cannot be enabled by login");
    assert.equal(await page.locator(".local-account-profile").count(), 1, "Model unavailability must not log out the account");
    assert.equal(await draft.inputValue(), "登录和配置之前保留这段草稿");
    await mkdir(".tmp/model-onboarding", { recursive: true });
    await page.locator(".model-menu").screenshot({ path: ".tmp/model-onboarding/cloud-empty-catalog.png" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.fixture.account = { ...window.fixture.account, models: window.fixture.catalog, gatewayCapabilities: { protocolVersion: 1, models: window.fixture.catalog.map(m => ({ id: m.id, available: false, reason: "QUOTA_UNAVAILABLE" })) } }; });
    await refreshAccount();
    assert.equal(await choices.first().isDisabled(), true, "Server quota denial remains disabled");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.fixture.account = { ...window.fixture.account, gatewayCapabilities: { protocolVersion: 1, models: window.fixture.catalog.map(m => ({ id: m.id, available: true })) } }; });
    await refreshAccount();
    assert.equal(await choices.first().isDisabled(), false);
    await page.keyboard.press("Escape");
    await page.locator(".local-account-profile").click();
    await page.getByRole("button", { name: /退出登录/ }).click();
    await page.waitForFunction(() => document.querySelector(".composer-run-actions .send-button").disabled);
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    assert.equal(await choices.first().isDisabled(), true);
    assert.equal(await draft.inputValue(), "登录和配置之前保留这段草稿");
    assert.equal(await page.evaluate(() => window.fixture.calls.filter((c) => c.type === "run").length), 0);
    await mkdir(".tmp/model-onboarding", { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      await page.locator(".model-menu").screenshot({ path: `.tmp/model-onboarding/${theme}.png` });
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "打开工作侧栏", exact: true }).click();
    await page.getByRole("button", { name: "侧边聊天", exact: true }).click();
    const sideDraft = page.getByRole("textbox", { name: "侧聊输入", exact: true });
    await sideDraft.fill("侧聊草稿也应保留");
    assert.equal(await page.getByRole("button", { name: "发送侧聊", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "侧聊模型", exact: true }).click();
    const sideMenu = page.getByRole("dialog", { name: "选择侧聊模型", exact: true });
    assert.equal(await sideMenu.getByRole("option").first().isDisabled(), true);
    assert.equal(await sideMenu.getByRole("option").nth(1).isDisabled(), true);
    const search = sideMenu.getByRole("textbox", { name: "搜索模型", exact: true });
    await search.fill("DeepSeek");
    await search.press("Enter");
    assert.equal(await sideMenu.isVisible(), true, "Enter must not choose a disabled Cloud model");
    await search.fill("own-model");
    await search.press("ArrowDown");
    assert.equal(await sideMenu.getByRole("option").evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("button", { name: "发送侧聊", exact: true }).isDisabled(), false);
    assert.equal(await sideDraft.inputValue(), "侧聊草稿也应保留");
    await page.getByRole("button", { name: "侧聊模型", exact: true }).click();
    await sideMenu.getByRole("button", { name: "添加自己的 API", exact: true }).click();
    assert.equal(await page.getByLabel("API Base URL", { exact: true }).inputValue(), "", "Side chat also opens a blank API form");
    assert.deepEqual(errors, []);
    console.log(`PASS full App onboarding (${production ? "production, strict CSP" : "dev"}): anonymous defaults, disabled models/send/Enter, retained drafts, canceled/failed/successful login, live logout, own-API save and selection, side-chat keyboard guards and setup entry; no model calls or renderer errors.`);
  }
} finally { await browser?.close(); if (production) await new Promise((resolve) => server.httpServer.close(resolve)); else await server.close(); }
