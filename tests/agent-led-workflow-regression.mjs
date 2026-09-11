import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness } from "../electron/agent-runtime-core.js";
import { assessDelivery, overlayReviewFindings } from "../electron/runtime/workflow-policy.js";
import { ToolProgressGuard } from "../electron/runtime/tool-progress-guard.js";
import { commandOutputPreview } from "../electron/runtime/evidence-ledger.js";
import { compactConversationForRequest, createTokenAccounting, estimateConversationTokens, recordProviderUsage, resolveScopedInstructions } from "../electron/agent-context-core.js";

const root = await mkdtemp(join(tmpdir(), "aporia-agent-led-"));
const originalFetch = globalThis.fetch;
const provider = { id: "test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "test",
  models: [{ id: "test", supportsTools: true, supportsThinking: false }] };
const sse = delta => new Response("data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\ndata: [DONE]\n\n");
const call = (name, input) => ({ name, input });
let scenarios = 0;
async function scenario(name, script, { permission = "workspace-write", approve = true, commandResult = { exitCode: 0, output: "ok" }, permissions = null, model = provider.models[0], messages = null, expectStatus = "completed" } = {}) {
  const workspace = join(root, name); await mkdir(workspace);
  await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node unrelated-test.js" } }));
  if (permissions) await writeFile(join(workspace, ".aporiax.json"), JSON.stringify({ permissions }));
  let requests = 0, commands = 0, approvals = 0;
  const receipts = [], events = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(!body.messages.some(m => /You are the AporiaX review subagent/.test(String(m.content))), "unexpected automatic Review");
    const trailing = [];
    for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) {
      trailing.unshift(JSON.parse(body.messages[i].content));
    }
    receipts.push(...trailing);
    const next = script[requests++];
    assert.ok(requests <= script.length + 1, "unexpected automatic workflow round");
    const tools = Array.isArray(next) ? next : next ? [next] : null;
    return sse(tools ? { tool_calls: tools.map((item, index) => ({ index, id: name + requests + "-" + index, type: "function",
      function: { name: item.name, arguments: JSON.stringify(item.input) } })) } : { content: "Delivered." });
  };
  const result = await runHarness({ runId: name, taskId: name, workspacePath: workspace, provider: { ...provider, models: [model] }, modelId: model.id || "test",
    permission, approvalMode: "manual", thinking: false, signal: AbortSignal.timeout(12000),
    messages: messages || [{ role: "user", content: "Build only the requested deliverable; unrelated project tests are out of scope." }],
    sandboxStatusResolver: async () => ({ available: false, localAvailable: true, state: "unavailable" }),
    sandboxExecutor: async () => { commands++; return commandResult; },
    requestApproval: async () => { approvals++; return { approved: approve }; }, onEvent: event => events.push(event) });
  assert.equal(result.status, expectStatus, result.content);
  scenarios++;
  return { result, receipts, commands, approvals, events, workspace };
}
try {
  await scenario("conversation", []);
  const html = await scenario("standalone", [
    call("write_file", { path: "game.html", content: "<!doctype html><title>Game</title>" }),
    call("write_file", { path: "temp-server.cjs", content: "// local preview server" }),
    call("update_plan", { explanation: "Deliver the requested files", steps: [{ id: "work", title: "Done", status: "completed" }] }),
  ]);
  assert.equal(html.commands, 0);
  assert.equal(html.result.selfCheck.delivery.status, "unverified");
  assert.equal(html.result.selfCheck.segments.length, 0);
  assert.equal(await readFile(join(html.workspace, "game.html"), "utf8"), "<!doctype html><title>Game</title>");
  const many = await scenario("many", Array.from({ length: 6 }, (_, i) => call("write_file", { path: "src/module" + i + ".js", content: "export default 1;" })));
  assert.equal(many.commands, 0); assert.equal(many.result.selfCheck.segments.length, 0);

  const fake = await scenario("fake-report", [
    call("write_file", { path: "a.js", content: "export default 1;" }),
    call("complete_self_check", { summary: "Tests passed", checks: ["Claimed test pass"], improvements: [], remaining_risks: [] }),
  ]);
  assert.equal(fake.receipts.at(-1).reportAccepted, true);
  assert.equal(fake.commands, 0); assert.equal(fake.result.selfCheck.verification.passed, false);
  assert.equal(fake.result.selfCheck.seal, null);

  const pass = await scenario("real-pass", [call("run_command", { command: "node --check a.js", cwd: ".", verification: true })]);
  assert.equal(pass.commands, 1); assert.equal(pass.result.selfCheck.delivery.status, "passed");
  assert.equal(pass.result.selfCheck.verification.results.length, 1, "read-only checks must retain evidence");
  const fail = await scenario("real-fail", [
    call("write_file", { path: "a.js", content: "wrong" }),
    call("run_command", { command: "node --check a.js", cwd: ".", verification: true }),
    call("request_self_check", { action: "skip", reason: "Deliver with known failure" }),
  ], { commandResult: { exitCode: 1, output: "Syntax error" } });
  assert.equal(fail.commands, 1); assert.equal(fail.result.selfCheck.delivery.status, "failed");
  assert.equal(fail.result.selfCheck.verification.results[0].output, "Syntax error");

  const stderrFail = await scenario("stderr-fail", [
    call("write_file", { path: "a.js", content: "wrong" }),
    call("run_command", { command: "node --check a.js", cwd: ".", verification: true }),
  ], { commandResult: { exitCode: 1, stdout: "", stderr: "Syntax error on stderr" } });
  assert.equal(stderrFail.result.selfCheck.verification.results[0].output, "Syntax error on stderr");

  const stale = await scenario("stale", [
    call("write_file", { path: "a.js", content: "export default 1;" }),
    call("run_command", { command: "node --check a.js", cwd: ".", verification: true }),
    call("write_file", { path: "a.js", content: "export default 2;" }),
  ]);
  assert.equal(stale.result.selfCheck.delivery.status, "unverified");
  assert.equal(stale.result.selfCheck.verification.results.length, 1, "stale receipt preserved");

  const parallelRead = await scenario("parallel-read", [
    call("write_file", { path: "a.js", content: "export default 1;\n" }),
    [call("read_file", { path: "a.js" }), call("read_file", { path: "package.json" })],
  ]);
  assert.equal(parallelRead.result.status, "completed");
  assert.ok(parallelRead.result.selfCheck.reviewedFiles.includes("a.js"), "parallel reads must record evidence without waiting for selfCheck.started");

  const external = join(root, "external.txt"); await writeFile(external, "outside read-only reference");
  const read = await scenario("external", [call("read_external_file", { path: external, reason: "Read the user reference" })], { permissions: { read_external_file: "ask" } });
  assert.equal(read.approvals, 1, JSON.stringify(read.receipts)); assert.match(JSON.stringify(read.receipts), /outside read-only reference/);
  const denied = await scenario("external-denied", [call("read_external_file", { path: external, reason: "Read reference" })], { approve: false, permissions: { read_external_file: "ask" } });
  assert.equal(denied.approvals, 1); assert.doesNotMatch(JSON.stringify(denied.receipts), /outside read-only reference/);
  const policyDenied = await scenario("external-policy-deny", [call("read_external_file", { path: external, reason: "Read reference" })], { permissions: { read_external_file: "deny" } });
  assert.equal(policyDenied.approvals, 0);
  assert.doesNotMatch(JSON.stringify(policyDenied.receipts), /outside read-only reference/);
  const invalid = await scenario("invalid-path", [
    call("read_file", { path: "../external.txt" }),
    call("read_file", { path: "package.json" }),
  ]);
  assert.match(JSON.stringify(invalid.receipts[0]), /PROJECT_INSTRUCTIONS_UNAVAILABLE/);
  assert.match(JSON.stringify(invalid.receipts[1]), /unrelated-test/);
  const invalidParallel = await scenario("invalid-path-parallel", [
    [call("read_file", { path: "../external.txt" }), call("read_file", { path: "package.json" })],
  ]);
  assert.match(JSON.stringify(invalidParallel.receipts.find(item => item.error)), /PROJECT_INSTRUCTIONS_UNAVAILABLE/);
  assert.match(JSON.stringify(invalidParallel.receipts.find(item => item.content || item.text || JSON.stringify(item).includes("unrelated-test"))), /unrelated-test/);

  // Instruction discovery commits only when the complete load succeeds.
  await mkdir(join(root, "scoped")); await writeFile(join(root, "scoped", "AGENTS.md"), "Do not modify files.");
  const context = { workspaceRoot: root, loadedFiles: new Set(), get rules() { throw Error("unreadable rule"); } };
  await assert.rejects(resolveScopedInstructions(context, ["scoped/file.js"]), /unreadable rule/);
  assert.equal(context.loadedFiles.size, 0);

  for (const size of [300000, 1000000, 8000000]) {
    const conversation = [{ role: "system", content: "Help with this image." }, { role: "user", content: [
      { type: "text", text: "Read this screenshot" }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(size) } },
    ] }];
    const accounting = createTokenAccounting();
    assert.ok(estimateConversationTokens(conversation, accounting) < 10000, "encoded bytes must not be text tokens");
    recordProviderUsage(accounting, { prompt_tokens: 5000 }, conversation);
    assert.equal(accounting.calibratedTokensPerCharacter, 0, "image usage must not poison text calibration");
    assert.equal(compactConversationForRequest({ conversation, contextCheckpoints: [], contextWindowTokens: 128000, accounting }), null);
  }
  const unknownImage = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } }] }];
  const remoteImage = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/shot.png" } }] }];
  const lowImage = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/shot.png", detail: "low" } }] }];
  assert.ok(estimateConversationTokens(unknownImage) >= 4096);
  assert.ok(estimateConversationTokens(remoteImage) >= 4096);
  assert.ok(estimateConversationTokens(lowImage) >= 1024);
  assert.ok(estimateConversationTokens(lowImage) < 4096);
  assert.throws(() => compactConversationForRequest({ conversation: [{ role: "user", content: "长".repeat(30000) }],
    contextCheckpoints: [], contextWindowTokens: 16000 }), error => error.code === "CONTEXT_BUDGET_EXCEEDED" && error.budget.inputBudget > 0);

  const vision = await scenario("native-vision", [], {
    messages: [{ role: "user", content: "Read this screenshot", attachments: [{ kind: "image", dataUrl: "data:image/png;base64," + "A".repeat(300000) }] }],
    model: { id: "test", supportsTools: true, supportsThinking: false, supportsImages: true },
  });
  assert.equal(vision.result.status, "completed");
  assert.ok((vision.result.contextStats?.estimatedPromptTokens || 0) < 20000, "native vision requests must not treat Base64 as text tokens");

  const blocked = await scenario("context-blocked", [], {
    messages: [{ role: "user", content: "长".repeat(40000) }],
    model: { id: "test", supportsTools: true, supportsThinking: false, contextWindow: 32000 },
    expectStatus: "blocked",
  });
  assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.result.contextBudget.inputBudget > 0, true);
  assert.match(blocked.result.content, /上下文预算/);

  const guard = new ToolProgressGuard(); let warnings = 0;
  for (let i = 0; i < 30; i++) if (guard.observe({ tool: "read_file", input: { path: "a" }, result: { text: "same" } })) warnings++;
  assert.ok(warnings >= 2);
  const bad = { command: "test", cwd: ".", passed: false, error: "ENOENT", exitCode: null, versionSignature: "current" };
  assert.equal(assessDelivery({ verificationResults: [bad], verificationWaived: true }, [], "current").status, "unavailable");
  assert.equal(commandOutputPreview({ stdout: "", stderr: "boom" }), "boom");

  const firstFinding = { severity: "high", path: "a.js", message: "old issue" };
  const overlayed = overlayReviewFindings([
    { verificationVersion: "v1", reviewAgentId: "r1", paths: ["a.js", "b.js"], findings: [firstFinding, { severity: "high", path: "b.js", message: "keep" }] },
    { verificationVersion: "v1", reviewAgentIds: [], paths: [], findings: [] },
    { verificationVersion: "v1", reviewAgentId: "r2", paths: ["a.js"], findings: [] },
  ], "v1");
  assert.equal(overlayed.some(item => item.path === "a.js"), false, "latest covering review replaces old findings");
  assert.equal(overlayed.some(item => item.path === "b.js"), true, "unreviewed sibling paths keep their findings");
  assert.equal(assessDelivery({
    segments: [
      { verificationVersion: "current", reviewAgentId: "r1", paths: ["a.js"], findings: [firstFinding] },
      { verificationVersion: "current", reviewAgentIds: [], findings: [] },
    ],
    verificationResults: [],
  }, [{ path: "a.js", afterContent: "1" }], "current").findings[0].path, "a.js");

  assert.equal(fake.result.selfCheck.completed, true);
  assert.equal(fake.result.selfCheck.verification.passed, false, "required:false completed must not be shown as a test pass");

  console.log("Agent-led workflow, real receipts, external path/approval and multimodal budget: PASS (" + scenarios + " runtime scenarios)");
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
