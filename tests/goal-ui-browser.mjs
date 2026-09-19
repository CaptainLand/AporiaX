import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { normalizeProviderInput, publicProviderSummary } from "../electron/provider-config.js";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, watch: null }, plugins: [{ name: "goal-provider-fixture", configureServer(dev) {
  dev.middlewares.use("/__goal/provider", async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    try { let body = ""; for await (const chunk of request) body += chunk;
      response.end(JSON.stringify(publicProviderSummary(normalizeProviderInput({ baseUrl: "https://fixture.invalid/v1", models: ["fixture"], ...JSON.parse(body) }))));
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })); }
  });
} }] });
let browser; const checks = [], errors = [];
try {
  await mkdir(".tmp/goal-ui", { recursive: true }); await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : "/usr/bin/chromium"), headless: true, ...(process.platform === "linux" ? { args: ["--no-sandbox"] } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "tests/fixtures/goal-loop.html");
  await page.getByText("Configure per-requirement acceptance (JSON)", { exact: true }).click();
  await page.getByRole("textbox", { name: "Task acceptance contract" }).fill('{"version":1,"requirements":[{"id":"r1","text":"Create source","checks":[{"type":"file_exists","path":"../escape"}]}]}');
  await page.getByRole("button", { name: "Save acceptance contract", exact: true }).click();
  await page.getByText(/ACCEPTANCE_OUTSIDE_WORKSPACE/).waitFor(); assert.equal(await page.evaluate(() => window.savedTask), undefined);
  const contract = { version: 1, enforce: true, requirements: [{ id: "r1", text: "Create source", checks: [{ type: "file_exists", path: "source.txt" }] }] };
  await page.getByRole("textbox", { name: "Task acceptance contract" }).fill(JSON.stringify(contract));
  await page.getByRole("button", { name: "Save acceptance contract", exact: true }).click(); await page.getByText("Saved for the next invocation.").waitFor();
  assert.equal((await page.evaluate(() => window.savedTask.taskContract)).requirements[0].checks[0].path, "source.txt");
  await page.getByRole("checkbox", { name: "Require current-version verification evidence" }).check();
  assert.equal(await page.evaluate(() => window.savedTask.loopPolicy.requireVerifiedChanges), true); checks.push("real settings: reject unsafe contract, save validated predicates and verification policy");
  assert.equal(await page.getByRole("combobox", {name: "Repeated failure policy", exact: true}).inputValue(), "advisory");
  await page.getByRole("combobox", {name: "Repeated failure policy", exact: true}).selectOption("strict");
  await page.getByRole("combobox", {name: "Replans per problem", exact: true}).selectOption("4");
  assert.equal(await page.evaluate(() => window.savedTask.loopPolicy.maxStrategyInterventions), 4);
  await page.getByRole("combobox", {name: "Repeated failure policy", exact: true}).selectOption("advisory");
  assert.equal(await page.getByRole("combobox", {name: "Replans per problem", exact: true}).count(), 0);
  assert.equal(await page.evaluate(() => window.savedTask.loopPolicy.strategyMode), "advisory");
  assert.equal(await page.evaluate(() => window.savedTask.loopPolicy.requireVerifiedChanges), true);
  checks.push("advisory default, strict per-problem budget and switch back preserve other settings");
  await page.getByRole("button", { name: "Disable configured acceptance" }).click(); assert.equal(await page.evaluate(() => window.savedTask.taskContract), null);
  await page.getByRole("button", { name: "Save acceptance contract", exact: true }).click(); assert.equal(await page.evaluate(() => window.savedTask.taskContract), undefined); checks.push("explicit disable differs from empty workspace-config selection");
  for (const protocol of ["responses", "anthropic-messages", "deepseek-chat", "chat-completions"]) {
    await page.getByRole("combobox", { name: "Provider protocol", exact: true }).selectOption(protocol);
    if (["responses", "anthropic-messages"].includes(protocol)) await page.getByRole("spinbutton", { name: "Native output token limit" }).fill("4096");
    if (protocol === "anthropic-messages") {
      await page.getByRole("combobox", { name: "Anthropic thinking protocol" }).selectOption("manual"); await page.getByRole("spinbutton", { name: "Thinking budget" }).fill("2048");
    }
    await page.getByRole("button", { name: "Save provider fixture" }).click();
    await page.waitForFunction((expected) => window.savedProvider?.protocol === expected, protocol);
    assert.equal(await page.evaluate(() => window.savedProvider.hasApiKey), false);
  }
  checks.push("actual provider fields -> real backend normalizer: four protocols and native budgets, no keys");
  await page.getByRole("combobox", { name: "Provider protocol", exact: true }).selectOption("anthropic-messages");
  await page.getByRole("spinbutton", { name: "Thinking budget" }).fill("4096"); await page.getByRole("button", { name: "Save provider fixture" }).click();
  await page.getByText(/native output\/thinking token budget/i).waitFor(); checks.push("backend rejects contradictory manual/output budgets");
  await page.getByText(/^Decisions and per-requirement acceptance/).click(); await page.getByText("decision-1 · Preserve original input").click();
  await page.getByText(/Agent assertion, not a pass/).waitFor(); await page.getByText(/read-original/).waitFor(); assert.equal(await page.evaluate(() => window.badInjection), undefined); checks.push("source-linked assertion and non-pass acceptance render as escaped text");
  for (const theme of ["light", "dark"]) for (const width of [1100, 420]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `.tmp/goal-ui/${theme}-${width}.png`, fullPage: true });
  }
  checks.push("light/dark 1100/420px layouts without horizontal overflow"); assert.deepEqual(errors, []);
  console.log(`PASS goal UI: ${checks.length} scenarios, no page errors`);
} finally {
  await mkdir(".tmp/audit-results", { recursive: true });
  await writeFile(".tmp/audit-results/goal-ui.json", JSON.stringify({ node: process.version, platform: process.platform, checks, errors }, null, 2));
  await browser?.close(); await server.close();
}
