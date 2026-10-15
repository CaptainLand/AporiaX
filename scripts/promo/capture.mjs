// Captures clean product stills for the AporiaX promo video.
// Uses the real renderer with sample data only: no personal workspace,
// account or credentials. Output: output/promo/shots/*.png (2560x1440).
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { createWitnessMonitor } from "../../electron/witness-monitor.js";

const OUT = "output/promo/shots";
const VIEWPORT = { width: 1600, height: 900 };
const SCALE = 1.6; // 2560x1440 stills for a 1440p/4K timeline.
await mkdir(OUT, { recursive: true });

// ---- Sample run built through the real Witness monitor -------------------
const base = Date.now() - 95_000; // Keeps live durations short and believable.
let clock = base;
const monitor = createWitnessMonitor({ heartbeatMs: 0, now: () => clock });
const emit = (event, step = 1400) => { clock += step; monitor.observe(event); };
emit({ type: "turn.started", agentBudget: { builderConcurrency: 4 } });
emit({ type: "plan.updated", plan: { revision: 1, steps: [
  { id: "p1", title: "梳理商品目录结构", status: "completed" },
  { id: "p2", title: "并行实现筛选与样式", status: "in_progress" },
  { id: "p3", title: "生成使用说明与周报", status: "pending" },
  { id: "p4", title: "运行测试并复核交付", status: "pending" },
] } });
emit({ type: "tool.started", callId: "t1", tool: "read_file", path: "src/catalog.ts" });
emit({ type: "tool.completed", callId: "t1", tool: "read_file", path: "src/catalog.ts", success: true });
emit({ type: "tool.started", callId: "t2", tool: "run_command", command: "npm test -- catalog" });
emit({ type: "tool.completed", callId: "t2", tool: "run_command", command: "npm test -- catalog", success: false, error: "1 failed: filters keep empty category", exitCode: 1 }, 3200);
emit({ type: "subagent.started", agentId: "explore-1", activationId: "explore-1:1", role: "explore", task: "定位筛选失败原因" });
emit({ type: "subagent.completed", agentId: "explore-1", activationId: "explore-1:1", status: "completed", acceptance: { status: "accepted" } }, 2600);
emit({ type: "subagent.started", agentId: "builder-1", activationId: "builder-1:1", role: "builder", task: "筛选逻辑" });
emit({ type: "subagent.tool.started", agentId: "builder-1", role: "builder", callId: "b1", tool: "edit_file", path: "src/catalog.ts" });
emit({ type: "subagent.started", agentId: "builder-2", activationId: "builder-2:1", role: "builder", task: "界面样式" });
emit({ type: "subagent.tool.started", agentId: "builder-2", role: "builder", callId: "b2", tool: "edit_file", path: "src/catalog.css" });
emit({ type: "agent_budget.queue", builderConcurrency: 4, runningBuilders: 2, queuedBuilders: 1 });
emit({ type: "subagent.started", agentId: "verify-1", activationId: "verify-1:1", role: "verify", task: "验证筛选回归" });
emit({ type: "subagent.tool.started", agentId: "verify-1", role: "verify", callId: "v1", tool: "run_command", command: "npm test -- catalog" });
const liveWitness = monitor.snapshot();
const now = new Date(clock).toISOString();

const changes = [
  { path: "src/catalog.ts", additions: 42, deletions: 9, beforeContent: "export const filter = (items) => items;\n", afterContent: "export const filter = (items, q) => items.filter((i) => i.category && i.name.includes(q));\n" },
  { path: "src/catalog.css", additions: 18, deletions: 4, beforeContent: ".grid{}\n", afterContent: ".grid{display:grid;gap:12px}\n" },
  { path: "docs/周报.docx", additions: 0, deletions: 0, created: true, binary: true },
];
const tasks = [
  { id: "demo", title: "商品目录：修复筛选并交付周报", workspacePath: "D:/Demo/storefront", workspaceName: "storefront", providerId: "demo", modelId: "demo-model", effort: "high",
    knowledgeEnabled: true, knowledgeProjectId: "legacy", createdAt: now, updatedAt: now,
    messages: [
      { id: "u1", role: "user", content: "修复商品目录的筛选问题，补上样式，并整理一份本周进展的 Word 周报。", createdAt: now },
      { id: "a1", role: "assistant", status: "running", sourceUserId: "u1", prompt: "修复商品目录的筛选问题，补上样式，并整理一份本周进展的 Word 周报。",
        content: "已定位问题：空分类没有被过滤，导致测试失败。\n\n- **Builder B01** 正在修改 `src/catalog.ts` 的筛选逻辑\n- **Builder B02** 正在调整 `src/catalog.css` 的网格样式\n- 周报会在验证通过后生成到 `docs/周报.docx`\n\n```ts\nexport const filter = (items, q) =>\n  items.filter((item) => item.category && item.name.includes(q));\n```",
        witness: liveWitness, plan: liveWitness.plan, changes, route: [], steps: [], createdAt: now },
    ] },
  { id: "t2", title: "整理发布说明", workspacePath: "D:/Demo/storefront", workspaceName: "storefront", createdAt: now, updatedAt: now, messages: [] },
  { id: "t3", title: "首页性能排查", workspacePath: "D:/Demo/storefront", workspaceName: "storefront", createdAt: now, updatedAt: now, messages: [] },
  { id: "t4", title: "季度汇报 PPT", workspacePath: "D:/Demo/reports", workspaceName: "reports", createdAt: now, updatedAt: now, messages: [] },
];
const facts = [
  ["architecture", "前端使用 React + Vite，商品数据通过 src/api/catalog.ts 统一读取。", "src/api/catalog.ts"],
  ["command", "npm test -- catalog 运行目录相关测试；提交前需要全部通过。", "package.json"],
  ["convention", "样式使用 CSS 变量，不引入新的 UI 框架。", "src/styles/tokens.css"],
  ["decision", "空分类在筛选阶段剔除，而不是在渲染时隐藏。", "docs/decisions.md"],
  ["module", "订单模块负责创建与查询订单，入口是 src/orders.ts。", "src/orders.ts"],
  ["known_issue", "Safari 下 grid gap 动画会闪烁，暂时关闭过渡。", "src/catalog.css"],
].map(([category, content, reference], i) => ({ id: `f${i}`, category, content, confidence: 0.86, lastConfirmedAt: new Date(base - i * 86400000).toISOString(), evidence: [{ type: "file", reference, detail: "来自任务中的文件读取与验证记录。" }] }));
const guide = "# 商品目录 · 使用说明\n\n筛选会剔除**空分类**，并按名称匹配关键字。\n\n| 模块 | 状态 |\n| --- | --- |\n| 筛选逻辑 | 已修复 |\n| 网格样式 | 已更新 |\n| 回归测试 | 运行中 |\n\n```bash\nnpm test -- catalog\n```\n";

// ---- Browser -------------------------------------------------------------
const server = await createServer({ logLevel: "error", server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });

async function openApp({ view = "dialogue", workbench = null, theme = "light" } = {}) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE, bypassCSP: true });
  page.on("pageerror", (error) => console.log("pageerror", error.message));
  await page.addInitScript(({ tasks, facts, guide, view, workbench, theme }) => {
    localStorage.clear();
    localStorage.setItem("aporiax.language.v1", "zh-CN");
    localStorage.setItem("aporiax.theme.v2", theme);
    localStorage.setItem("aporiax.session-ui.v1", JSON.stringify({ taskId: "demo", view, welcomeDismissed: true }));
    if (workbench) localStorage.setItem("aporiax.workbench.v1::" + encodeURIComponent("D:/Demo/storefront") + ":demo", JSON.stringify(workbench));
    const tree = ["src", "docs", "tests", "package.json", "README.md", "vite.config.ts"];
    const provider = { id: "demo", name: "示例模型服务", models: [{ id: "demo-model", name: "Demo Model", shortName: "Demo Model", contextWindow: 128000 }] };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: "anonymous" }) },
      providers: { list: async () => [provider] },
      tasks: { load: async () => tasks, save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true, available: true }) },
      update: { status: async () => ({ phase: "idle" }), subscribe: () => () => {}, check: async () => ({ phase: "idle" }) },
      workspace: {
        listTree: async (root, directory = ".") => ({ entries: (directory === "." ? tree : directory === "src" ? ["src/catalog.ts", "src/catalog.css", "src/orders.ts", "src/api"] : directory === "docs" ? ["docs/guide.md", "docs/周报.docx", "docs/decisions.md"] : []).map((path) => ({ path, name: path.split("/").at(-1), type: /\./.test(path.split("/").at(-1)) ? "file" : "directory" })) }),
        readPreview: async (root, path) => ({ path, content: path.endsWith(".md") ? guide : "export const filter = (items, q) =>\n  items.filter((item) => item.category && item.name.includes(q));\n", binary: false }),
      },
      understanding: {
        projects: async () => [{ id: "legacy", name: "storefront" }],
        get: async () => ({ facts, currentRevision: 7, settings: { useForContext: true, autoCurate: true }, revisions: [] }),
      },
      workbench: { subscribe: () => () => {}, request: async (input) => input.action === "list" ? [] : input.action === "file-check" ? { status: "present" } : true },
      sideChat: { request: async () => ({ messages: [] }), subscribe: () => () => {} },
    };
  }, { tasks, facts, guide, view, workbench, theme });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "domcontentloaded" });
  await page.locator(".ax-welcome__enter, .thread-view-tabs").first().waitFor({ timeout: 30000 });
  if (await page.locator(".ax-welcome__enter").isVisible().catch(() => false)) await page.locator(".ax-welcome__enter").click();
  await page.waitForTimeout(1200);
  const tabLabel = { route: "执行记录", understanding: "项目知识", workspace: "工作区" }[view];
  if (tabLabel) { await page.locator(".thread-view-tabs").getByRole("button", { name: tabLabel, exact: true }).click(); await page.waitForTimeout(700); }
  return page;
}
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("shot", name); };

try {
  // 01 Conversation with the deliverable previewed beside it.
  let page = await openApp({ workbench: { open: true, width: 640, follow: true, active: "file:docs/guide.md", tabs: [{ id: "file:docs/guide.md", kind: "file", title: "guide.md", path: "docs/guide.md" }] } });
  await page.waitForTimeout(800);
  await shot(page, "01-conversation");
  await page.close();

  // 02 Activity overview + 03 parallel builders + 04 failure expanded inline.
  page = await openApp({ view: "route" });
  await page.locator(".thread-view-panel.active .route-activity").waitFor();
  await shot(page, "02-activity");
  await page.locator(".thread-view-panel.active .ra-current").scrollIntoViewIfNeeded();
  await shot(page, "03-builders");
  await page.locator(".thread-view-panel.active .ra-event.failed .ra-detail-button").click();
  await page.waitForTimeout(400);
  await page.locator(".thread-view-panel.active .ra-event.failed").scrollIntoViewIfNeeded();
  await shot(page, "04-failure");
  await page.locator(".thread-view-panel.active .ra-change-list button").first().click();
  await page.locator(".review-panel").waitFor().catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, "05-diff");
  await page.close();

  // 06 Permissions: task settings panel with each execution mode.
  page = await openApp();
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "任务设置" }).click();
  await page.waitForTimeout(500);
  for (const [label, name] of [["直接", "06a-direct"], ["安全", "06b-safe"], ["隔离", "06c-isolated"]]) {
    await page.locator('[aria-label="命令执行模式"]').getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, name);
  }
  await page.close();

  // 07 Project knowledge with the inspector open.
  page = await openApp({ view: "understanding" });
  await page.locator(".thread-view-panel.active .knowledge-item").first().waitFor();
  await shot(page, "07a-knowledge");
  await page.locator(".thread-view-panel.active .knowledge-detail-trigger").first().click();
  await page.waitForTimeout(400);
  await shot(page, "07b-knowledge-detail");
  await page.close();

  // 08 Dark theme hero of the activity view for contrast cuts.
  page = await openApp({ view: "route", theme: "dark" });
  await page.locator(".thread-view-panel.active .route-activity").waitFor();
  await shot(page, "08-activity-dark");
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
