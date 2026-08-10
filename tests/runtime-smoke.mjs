import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import {
  captureWorkspaceState,
  getPendingSelfCheckPaths,
  listWorkspaceTree,
  readWorkspacePreview,
  restoreWorkspaceAnchor,
  revertWorkspaceChanges,
  runHarness,
  saveWorkspaceTextFile,
  sanitizeConversation,
} from "../electron/agent-runtime.js";
import {
  ToolRegistry,
  createPermissionPolicy,
  getToolPermission,
} from "../electron/agent-core.js";
import {
  createOfficeArtifact,
  inspectOfficeArtifact,
} from "../electron/office-tools.js";
import { parseAttachment } from "../electron/attachment-parser.js";
import {
  DEFAULT_DEEPSEEK_PROVIDER,
  inferModelCapabilities,
  normalizeProviderBaseUrl,
  normalizeProviderInput,
} from "../electron/provider-config.js";
import {
  SANDBOX_IMAGE,
  buildDockerSandboxArgs,
  createHostFallbackEnvironment,
  runLocalSandboxedCommand,
} from "../electron/sandbox-runtime.js";
import {
  acknowledgeRecoverableRun,
  appendRunJournalEvent,
  beginRunJournal,
  finishRunJournal,
  listRecoverableRuns,
  updateRunJournalMetadata,
} from "../electron/run-store.js";
import {
  compactConversationForRequest,
  createProjectMemoryStore,
  createTokenAccounting,
  estimateConversationTokens,
  loadProjectInstructionContext,
  mergeTokenUsage,
  recordProviderUsage,
  resolveScopedInstructions,
} from "../electron/agent-context.js";
import { createWitnessMonitor } from "../electron/witness-monitor.js";
import { createProjectUnderstandingStore } from "../electron/project-understanding.js";

const testRoot = await mkdtemp(join(resolve("."), ".runtime-smoke-"));
const originalFetch = globalThis.fetch;
const testProvider = {
  ...DEFAULT_DEEPSEEK_PROVIDER,
  models: DEFAULT_DEEPSEEK_PROVIDER.models.map((model) => ({
    ...model,
  })),
  apiKey: "sk-runtime-smoke-test",
};
const testSandboxStatus = {
  backend: "test",
  state: "ready",
  available: true,
  localAvailable: true,
  autoApprovalSafe: true,
  detail: "Test sandbox ready.",
  image: "test",
  imageReady: true,
  network: "none",
  filesystem: "workspace-write",
  rootFilesystem: "read-only",
  memory: "256m",
  cpus: 1,
  pidsLimit: 32,
};

async function testSandboxExecutor({ command, cwd, signal }) {
  if (signal?.aborted) {
    const error = new Error("Test sandbox interrupted.");
    error.name = "AbortError";
    throw error;
  }
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    timedOut: Boolean(result.error?.code === "ETIMEDOUT"),
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    sandbox: testSandboxStatus,
  };
}

function runTestHarness(request) {
  return runHarness({
    ...request,
    provider: testProvider,
    sandboxExecutor: testSandboxExecutor,
    sandboxStatusResolver: async () => testSandboxStatus,
  });
}

function createSseResponse(delta) {
  return new Response(
    `data: ${JSON.stringify({
      choices: [{ delta }],
    })}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

function createToolDelta(id, name, input) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(input),
        },
      },
    ],
  };
}

function createToolCallsDelta(calls) {
  return {
    tool_calls: calls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input),
      },
    })),
  };
}

function createPdfFixture(text = "Hello from PDF") {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

try {
  let witnessNow = 1_000;
  const witnessEvents = [];
  const witnessMonitor = createWitnessMonitor({
    emit: (event) => witnessEvents.push(event),
    heartbeatMs: 0,
    now: () => witnessNow,
  });
  witnessMonitor.observe({ type: "turn.started" });
  witnessMonitor.observe({ type: "response.reset", round: 1, phase: "work" });
  witnessMonitor.observe({
    type: "tool.started",
    callId: "witness-read-1",
    tool: "read_file",
    path: "src/main.js",
  });
  witnessNow += 46_000;
  witnessMonitor.heartbeat();
  assert.equal(witnessMonitor.snapshot().current?.longRunning, true);
  witnessMonitor.observe({
    type: "tool.completed",
    callId: "witness-read-1",
    tool: "read_file",
    success: true,
    path: "src/main.js",
  });
  for (let index = 0; index < 3; index += 1) {
    witnessNow += 1_000;
    witnessMonitor.observe({
      type: "tool.started",
      callId: `witness-failure-${index}`,
      tool: "run_command",
      command: "npm test",
    });
    witnessMonitor.observe({
      type: "tool.completed",
      callId: `witness-failure-${index}`,
      tool: "run_command",
      success: false,
      detail: "test failed",
    });
  }
  witnessMonitor.observe({
    type: "subagent.started",
    agentId: "witness-agent-1",
    role: "review",
    task: "Review the changed files.",
  });
  assert.equal(witnessMonitor.snapshot().counters.activeAgents, 1);
  witnessMonitor.observe({
    type: "subagent.completed",
    agentId: "witness-agent-1",
    role: "review",
    status: "completed",
    summary: "No blocking findings.",
  });
  witnessMonitor.observe({ type: "turn.completed" });
  const witnessSnapshot = witnessMonitor.snapshot();
  assert.equal(witnessSnapshot.status, "completed");
  assert.equal(witnessSnapshot.counters.activeAgents, 0);
  assert.equal(witnessSnapshot.records[0].eventType, "turn.started");
  assert.equal(witnessSnapshot.records.at(-1).eventType, "turn.completed");
  assert(
    witnessSnapshot.alerts.some((alert) =>
      alert.code.startsWith("repeated-failure:run_command"),
    ),
  );
  assert(
    witnessEvents.some((event) => event.type === "witness.updated"),
  );
  witnessMonitor.dispose();

  const contextFixtureRoot = join(testRoot, "context-fixture");
  const contextFeatureRoot = join(contextFixtureRoot, "src", "feature");
  await mkdir(contextFeatureRoot, { recursive: true });
  await mkdir(join(contextFixtureRoot, ".aporiax", "rules"), {
    recursive: true,
  });
  await writeFile(
    join(contextFixtureRoot, "AGENTS.md"),
    "Use project-wide verification commands.\n",
    "utf8",
  );
  await writeFile(
    join(contextFixtureRoot, "src", "APORIAX.md"),
    "Files under src must use named exports.\n",
    "utf8",
  );
  await writeFile(
    join(contextFixtureRoot, ".aporiax", "rules", "javascript.md"),
    [
      "---",
      "paths:",
      "  - src/**/*.js",
      "---",
      "JavaScript changes must include a focused syntax check.",
    ].join("\n"),
    "utf8",
  );
  const instructionContext = await loadProjectInstructionContext(
    contextFixtureRoot,
  );
  assert.deepEqual(instructionContext.root.files, ["AGENTS.md"]);
  const scopedInstructions = await resolveScopedInstructions(
    instructionContext,
    ["src/feature/example.js"],
  );
  assert(scopedInstructions.files.includes("src/APORIAX.md"));
  assert(scopedInstructions.files.includes(".aporiax/rules/javascript.md"));
  assert.match(scopedInstructions.content, /named exports/);
  assert.match(scopedInstructions.content, /syntax check/);

  const directScopedContext = await loadProjectInstructionContext(
    contextFixtureRoot,
  );
  const directScopedInstructions = await resolveScopedInstructions(
    directScopedContext,
    ["src/example.js"],
  );
  assert(
    directScopedInstructions.files.includes("src/APORIAX.md"),
    "a directory-level instruction file should apply to direct child files",
  );
  assert(
    directScopedInstructions.files.includes(
      ".aporiax/rules/javascript.md",
    ),
    "a **/ path rule should also match files directly below its prefix",
  );

  const directoryScopedContext = await loadProjectInstructionContext(
    contextFixtureRoot,
  );
  const directoryScopedInstructions = await resolveScopedInstructions(
    directoryScopedContext,
    ["src"],
  );
  assert(
    directoryScopedInstructions.files.includes("src/APORIAX.md"),
    "directory operations should load instructions located in that directory",
  );

  const memoryStore = await createProjectMemoryStore({
    baseDirectory: join(testRoot, "memory"),
    workspaceRoot: contextFixtureRoot,
  });
  await memoryStore.remember({
    category: "command",
    content: "Use npm run test:runtime for the Harness regression suite.",
    evidence: "package.json",
  });
  assert.equal(
    memoryStore.retrieve("Harness regression command", 4)[0]?.category,
    "command",
  );
  await assert.rejects(
    () =>
      memoryStore.remember({
        category: "preference",
        content: "API key sk-1234567890abcdefghijklmnop",
      }),
    /Secrets and credentials/,
  );

  const understandingStore = await createProjectUnderstandingStore({
    baseDirectory: join(testRoot, "understanding"),
    workspaceRoot: contextFixtureRoot,
  });
  const firstUnderstandingCommit = await understandingStore.commit({
    taskId: "task-understanding-1",
    runId: "run-understanding-1",
    summary: "Record the project test architecture",
    changes: [
      {
        operation: "upsert",
        category: "architecture",
        content: "Runtime smoke tests live in tests/runtime-smoke.mjs.",
        confidence: 0.92,
        evidence: [
          {
            type: "file",
            reference: "tests/runtime-smoke.mjs",
            detail: "Verified by the curator fixture.",
          },
        ],
      },
    ],
  });
  assert(firstUnderstandingCommit.committed);
  assert.equal(firstUnderstandingCommit.state.currentRevision, 1);
  assert.equal(
    understandingStore.retrieve("runtime smoke tests", 4)[0]?.category,
    "architecture",
  );

  const repeatedUnderstandingCommit = await understandingStore.commit({
    taskId: "task-understanding-2",
    summary: "Confirm the same project test architecture",
    changes: [
      {
        operation: "upsert",
        category: "architecture",
        content: "Runtime smoke tests live in tests/runtime-smoke.mjs.",
        confidence: 0.95,
        evidence: [
          {
            type: "file",
            reference: "tests/runtime-smoke.mjs",
            detail: "Confirmed by a later task.",
          },
        ],
      },
    ],
  });
  assert.equal(repeatedUnderstandingCommit.state.facts.length, 1);
  assert.equal(repeatedUnderstandingCommit.state.facts[0].occurrences, 2);

  await understandingStore.commit({
    taskId: "task-understanding-3",
    summary: "Record a temporary decision",
    changes: [
      {
        category: "decision",
        content: "A temporary decision used only to test revision rollback.",
        confidence: 0.8,
        evidence: ["tests/runtime-smoke.mjs"],
      },
    ],
  });
  const revertedUnderstanding = await understandingStore.revertTo(
    firstUnderstandingCommit.revision.id,
    { taskId: "task-understanding-revert" },
  );
  assert.equal(revertedUnderstanding.state.currentRevision, 4);
  assert.equal(revertedUnderstanding.state.facts.length, 1);
  assert.equal(
    revertedUnderstanding.revision.revertedFrom,
    firstUnderstandingCommit.revision.id,
  );
  const reloadedUnderstanding = await createProjectUnderstandingStore({
    baseDirectory: join(testRoot, "understanding"),
    workspaceRoot: contextFixtureRoot,
  });
  assert.equal(reloadedUnderstanding.snapshot().currentRevision, 4);
  await assert.rejects(
    () =>
      understandingStore.commit({
        summary: "Reject secrets",
        changes: [
          {
            category: "preference",
            content: "Use API key sk-1234567890abcdefghijklmnop",
            confidence: 0.9,
            evidence: ["user input"],
          },
        ],
      }),
    /Secrets and credentials/,
  );
  await assert.rejects(
    () =>
      memoryStore.remember({
        category: "command",
        content: "Use the configured release command.",
        evidence: "authorization: bearer test-token-that-must-not-persist",
      }),
    /Secrets and credentials/,
  );

  const tokenAccounting = createTokenAccounting();
  const shortConversation = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "检查 src/example.js 并运行 npm test" },
  ];
  const heuristicTokens = estimateConversationTokens(
    shortConversation,
    tokenAccounting,
  );
  recordProviderUsage(
    tokenAccounting,
    { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1_000 },
    shortConversation,
  );
  assert.equal(tokenAccounting.source, "provider-usage-calibrated");
  assert(
    estimateConversationTokens(shortConversation, tokenAccounting) >= 900,
  );
  assert.deepEqual(
    mergeTokenUsage(
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      { input_tokens: 80, output_tokens: 10 },
    ),
    { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 },
  );
  assert(heuristicTokens > 0);

  const compactConversation = [
    { role: "system", content: "Stable system instructions" },
  ];
  for (let index = 0; index < 70; index += 1) {
    compactConversation.push({
      role: index % 2 ? "assistant" : "user",
      content: `${index} ${"long context requirement ".repeat(80)}`,
    });
  }
  const compactEvents = [];
  const checkpoints = [];
  const checkpoint = compactConversationForRequest({
    conversation: compactConversation,
    onEvent: (event) => compactEvents.push(event),
    contextCheckpoints: checkpoints,
    contextWindowTokens: 32_000,
    accounting: createTokenAccounting(),
    plan: {
      revision: 2,
      steps: [{ id: "verify", title: "Verify result", status: "in_progress" }],
    },
    relevantMemory: memoryStore.facts,
  });
  assert.equal(checkpoint?.version, 2);
  assert.equal(checkpoints.length, 1);
  assert.equal(compactEvents[0]?.type, "context.compacted");
  assert.equal(compactConversation[0].content, "Stable system instructions");

  const journalRoot = join(testRoot, "run-journal");
  await beginRunJournal(journalRoot, {
    runId: "runtime-resume-1",
    taskId: "task-1",
    assistantId: "assistant-1",
    sourceUserId: "user-1",
    prompt: "Continue a durable task",
    workspacePath: testRoot,
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
  });
  await appendRunJournalEvent(journalRoot, "runtime-resume-1", {
    type: "tool.started",
    tool: "read_file",
  });
  await updateRunJournalMetadata(journalRoot, "runtime-resume-1", {
    status: "paused",
    lastEventType: "control.paused",
  });
  assert.deepEqual(
    (await listRecoverableRuns(journalRoot)).map((record) => record.runId),
    ["runtime-resume-1"],
    "paused runs should survive process restarts and be offered for recovery",
  );
  await acknowledgeRecoverableRun(journalRoot, "runtime-resume-1");
  assert.equal((await listRecoverableRuns(journalRoot)).length, 0);

  await beginRunJournal(journalRoot, {
    runId: "runtime-complete-1",
    taskId: "task-2",
    assistantId: "assistant-2",
  });
  await finishRunJournal(journalRoot, "runtime-complete-1", {
    status: "completed",
    changes: [{ path: "done.txt" }],
  });
  assert.equal((await listRecoverableRuns(journalRoot)).length, 0);

  assert.equal(
    normalizeProviderBaseUrl(
      "https://api.example.com/v1/chat/completions",
    ),
    "https://api.example.com/v1",
  );
  assert.equal(
    inferModelCapabilities("gpt-5.2", "openai").supportsImages,
    true,
  );
  const customProvider = normalizeProviderInput({
    name: "Example",
    baseUrl: "https://api.example.com/v1",
    models: ["gpt-5.2", "qwen3-coder"],
  });
  assert.equal(customProvider.models.length, 2);
  assert.equal(customProvider.models[0].supportsThinking, false);
  const inferredProvider = normalizeProviderInput({
    name: "",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.2"],
  });
  assert.equal(inferredProvider.name, "OpenAI");
  assert.equal(inferredProvider.models[0].id, "gpt-5.2");

  const sandboxArgs = buildDockerSandboxArgs({
    command: "npm test",
    workspaceRoot: "D:\\workspace",
    cwd: "packages/app",
    containerName: "aporiax-test",
    protectGit: true,
  });
  assert.equal(sandboxArgs[0], "run");
  assert(sandboxArgs.includes("--network"));
  assert(sandboxArgs.includes("none"));
  assert(sandboxArgs.includes("--read-only"));
  assert(sandboxArgs.includes("ALL"));
  assert(sandboxArgs.includes("no-new-privileges=true"));
  assert(sandboxArgs.includes(SANDBOX_IMAGE));
  assert.equal(sandboxArgs.at(-1), "npm test");
  const hostEnvironment = createHostFallbackEnvironment({
    Path: "C:\\Windows",
    PATH: "duplicate",
    DEEPSEEK_API_KEY: "must-not-leak",
    AUTHORIZATION: "must-not-leak",
    NODE_OPTIONS: "--require malicious.js",
    SAFE_VALUE: "kept",
  });
  assert.equal(hostEnvironment.DEEPSEEK_API_KEY, undefined);
  assert.equal(hostEnvironment.AUTHORIZATION, undefined);
  assert.equal(hostEnvironment.NODE_OPTIONS, undefined);
  assert.equal(hostEnvironment.SAFE_VALUE, "kept");
  assert.equal(
    Object.keys(hostEnvironment).filter(
      (name) => name.toUpperCase() === "PATH",
    ).length,
    1,
  );
  assert.equal(
    hostEnvironment.APORIAX_EXECUTION_MODE,
    "local-workspace-sandbox",
  );

  const localSandboxRoot = join(testRoot, "local-sandbox-fixture");
  await mkdir(localSandboxRoot, { recursive: true });
  await writeFile(join(localSandboxRoot, "changed.txt"), "before\n");
  await writeFile(
    join(localSandboxRoot, "sandbox-write-fixture.cjs"),
    "const fs = require('fs');\nfs.writeFileSync('changed.txt', 'after');\nfs.writeFileSync('created.txt', 'new');\n",
  );
  const localSandboxResult = await runLocalSandboxedCommand({
    command: "node sandbox-write-fixture.cjs",
    workspaceRoot: localSandboxRoot,
    cwd: localSandboxRoot,
    localSandboxBaseDirectory: testRoot,
    sandboxStatus: {
      state: "engine-stopped",
      available: false,
      localAvailable: true,
      autoApprovalSafe: true,
      detail: "Docker is optional in this test.",
    },
  });
  assert.equal(localSandboxResult.exitCode, 0);
  assert.equal(localSandboxResult.sandbox.backend, "local-workspace");
  assert.equal(localSandboxResult.sandbox.isolation, "workspace-copy");
  assert.equal(
    localSandboxResult.sandbox.sync.changed,
    2,
    JSON.stringify(localSandboxResult),
  );
  assert.equal(
    await readFile(join(localSandboxRoot, "changed.txt"), "utf8"),
    "after",
  );
  assert.equal(
    await readFile(join(localSandboxRoot, "created.txt"), "utf8"),
    "new",
  );

  const readOnlyPolicy = createPermissionPolicy("read-only", {
    read_file: "allow",
    write_file: "allow",
    git_diff: "ask",
  });
  assert.equal(getToolPermission(readOnlyPolicy, "read_file"), "allow");
  assert.equal(
    getToolPermission(readOnlyPolicy, "write_file"),
    "deny",
    "project config must not elevate a read-only task",
  );
  assert.equal(getToolPermission(readOnlyPolicy, "git_diff"), "ask");
  assert.equal(
    getToolPermission(readOnlyPolicy, "inspect_office_file"),
    "allow",
  );
  assert.equal(
    getToolPermission(readOnlyPolicy, "create_word_document"),
    "deny",
  );
  const askForAllReads = createPermissionPolicy("read-only", {
    "*": "ask",
  });
  assert.equal(
    getToolPermission(askForAllReads, "read_file"),
    "ask",
    "wildcard restrictions should apply to named tools",
  );
  assert.equal(
    getToolPermission(askForAllReads, "write_file"),
    "deny",
    "wildcard restrictions must not elevate denied tools",
  );

  const restrictedWritePolicy = createPermissionPolicy(
    "workspace-write",
    {
      write_file: "ask",
      run_command: "deny",
      complete_self_check: "deny",
    },
  );
  assert.equal(
    getToolPermission(restrictedWritePolicy, "write_file"),
    "ask",
  );
  assert.equal(
    getToolPermission(restrictedWritePolicy, "run_command"),
    "deny",
  );
  const noDelegationPolicy = createPermissionPolicy(
    "workspace-write",
    {
      delegate_subagent: "deny",
      collect_subagents: "deny",
      remember_project_fact: "deny",
    },
  );
  assert.equal(
    getToolPermission(noDelegationPolicy, "delegate_subagent"),
    "deny",
    "repository config may restrict optional Harness capabilities",
  );
  assert.equal(
    getToolPermission(noDelegationPolicy, "remember_project_fact"),
    "deny",
  );
  assert.equal(
    getToolPermission(
      restrictedWritePolicy,
      "complete_self_check",
    ),
    "allow",
    "repository config must not disable Harness control tools",
  );

  const registry = new ToolRegistry([
    {
      risk: "read",
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "fixture",
          parameters: { type: "object", properties: {} },
        },
      },
    },
    {
      risk: "write",
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "fixture",
          parameters: { type: "object", properties: {} },
        },
      },
    },
  ]);
  assert.deepEqual(
    registry
      .definitions(readOnlyPolicy)
      .map((definition) => definition.function.name),
    ["read_file"],
  );

  const textOnlyHistory = sanitizeConversation([
    {
      role: "user",
      content: "这是什么图片？",
      attachments: [
        {
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
    },
    {
      role: "assistant",
      content: "unknown variant `image_url`, expected `text`",
      status: "failed",
      error: true,
    },
    {
      role: "user",
      content: "生成一个 Electron 版本的 Minecraft",
    },
  ]);
  assert.equal(textOnlyHistory.length, 2);
  assert.equal(
    JSON.stringify(textOnlyHistory).includes("image_url"),
    false,
    "text-only model history must not contain image_url payloads",
  );
  assert.match(
    textOnlyHistory[0].content,
    /当前模型不支持读取本消息中的图片附件/,
  );
  assert.equal(
    textOnlyHistory.some((message) =>
      message.content.includes("unknown variant"),
    ),
    false,
    "failed assistant responses must not pollute later requests",
  );

  const markdownAttachment = await parseAttachment({
    name: "brief.md",
    type: "text/markdown",
    data: new TextEncoder().encode("# Brief\n\nBuild the thing."),
  });
  assert.equal(markdownAttachment.kind, "document");
  assert.equal(markdownAttachment.format, "MD");
  assert.match(markdownAttachment.content, /Build the thing/);

  const pdfFixture = createPdfFixture();
  const pdfAttachment = await parseAttachment({
    name: "reference.pdf",
    type: "application/pdf",
    data: new Uint8Array(pdfFixture),
  });
  assert.equal(pdfAttachment.format, "PDF");
  assert.equal(pdfAttachment.pageCount, 1);
  assert.equal(pdfAttachment.requiresOcr, false);
  assert.match(pdfAttachment.content, /Hello from PDF/);

  const attachmentHistory = sanitizeConversation([
    {
      role: "user",
      content: "请阅读附件。",
      attachments: [markdownAttachment, pdfAttachment],
    },
  ]);
  assert.match(attachmentHistory[0].content, /brief\.md/);
  assert.match(attachmentHistory[0].content, /Hello from PDF/);
  assert.equal(
    JSON.stringify(attachmentHistory).includes(pdfFixture.toString("base64")),
    false,
    "parsed attachments must not send binary source data to the model",
  );

  const localSandboxResponses = [
    createToolDelta("local-sandbox-command", "run_command", {
      command: "node --version",
      cwd: ".",
      reason: "验证运行环境。",
    }),
    { content: "Local sandbox command completed automatically." },
  ];
  let localSandboxIndex = 0;
  let localSandboxExecutorCalled = false;
  let englishSystemPrompt = "";
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    englishSystemPrompt = requestBody.messages?.[0]?.content || "";
    const delta = localSandboxResponses[localSandboxIndex];
    localSandboxIndex += 1;
    if (!delta) {
      throw new Error("Unexpected extra local-sandbox request.");
    }
    return createSseResponse(delta);
  };
  const localSandboxHarnessResult = await runHarness({
    provider: testProvider,
    workspacePath: testRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    approvalMode: "sandbox-auto",
    language: "en",
    messages: [{ role: "user", content: "运行版本检查。" }],
    sandboxStatusResolver: async () => ({
      ...testSandboxStatus,
      available: false,
      localAvailable: true,
      autoApprovalSafe: true,
      executionMode: "local-workspace",
      state: "engine-stopped",
      detail: "Docker stopped.",
    }),
    sandboxExecutor: async ({ sandboxStatus }) => {
      localSandboxExecutorCalled = true;
      assert.equal(sandboxStatus.state, "engine-stopped");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "v20.20.2\n",
        stderr: "",
        sandbox: {
          backend: "local-workspace",
          fallback: true,
          network: "host",
          isolation: "workspace-copy",
        },
      };
    },
    requestApproval: async () => {
      throw new Error(
        "Local sandbox commands must not request approval in automatic mode.",
      );
    },
  });
  assert.equal(localSandboxHarnessResult.status, "completed");
  assert.equal(localSandboxExecutorCalled, true);
  assert.equal(localSandboxHarnessResult.steps[0]?.success, true);
  assert.equal(
    localSandboxHarnessResult.steps[0]?.command,
    "node --version",
  );
  assert.match(
    englishSystemPrompt,
    /Reply to the user in English/,
    "the selected interface language must reach the Harness system prompt",
  );
  assert.match(
    englishSystemPrompt,
    /temporary copy of the authorized workspace/,
    "the Harness must describe local workspace isolation accurately",
  );

  const parallelRoot = join(testRoot, "parallel-tools");
  await mkdir(parallelRoot, { recursive: true });
  await writeFile(join(parallelRoot, "one.txt"), "first\n", "utf8");
  await writeFile(join(parallelRoot, "two.txt"), "second\n", "utf8");
  const parallelResponses = [
    createToolCallsDelta([
      { id: "parallel-read-1", name: "read_file", input: { path: "one.txt" } },
      { id: "parallel-read-2", name: "read_file", input: { path: "two.txt" } },
    ]),
    { content: "Both independent files were inspected." },
  ];
  let parallelResponseIndex = 0;
  const parallelEvents = [];
  globalThis.fetch = async () => {
    const delta = parallelResponses[parallelResponseIndex];
    parallelResponseIndex += 1;
    if (!delta) throw new Error("Unexpected extra parallel model request.");
    return createSseResponse(delta);
  };
  const parallelResult = await runTestHarness({
    workspacePath: parallelRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "read-only",
    messages: [{ role: "user", content: "Inspect both independent files." }],
    onEvent: (event) => parallelEvents.push(event),
  });
  assert.equal(parallelResult.status, "completed");
  assert.equal(parallelResult.steps.filter((step) => step.parallel).length, 2);
  assert.equal(
    parallelEvents.some((event) => event.type === "parallel_batch.started"),
    true,
  );
  assert.equal(
    parallelEvents.filter((event) => event.type === "tool.started").length,
    2,
  );

  const subagentRoot = join(testRoot, "subagent-tools");
  await mkdir(subagentRoot, { recursive: true });
  await writeFile(
    join(subagentRoot, "architecture.txt"),
    "The runtime uses an event journal.\n",
    "utf8",
  );
  const subagentResponses = [
    createToolDelta("delegate-1", "delegate_subagent", {
      role: "explore",
      task: "Read architecture.txt and report the runtime persistence mechanism.",
      scope: ["architecture.txt"],
      background: false,
      max_rounds: 4,
    }),
    createToolDelta("sub-read-1", "read_file", {
      path: "architecture.txt",
    }),
    { content: "The runtime persists progress through an event journal." },
    { content: "The explore subagent confirmed that persistence uses an event journal." },
  ];
  let subagentResponseIndex = 0;
  const subagentEvents = [];
  globalThis.fetch = async () => {
    const delta = subagentResponses[subagentResponseIndex];
    subagentResponseIndex += 1;
    if (!delta) throw new Error("Unexpected extra subagent model request.");
    return createSseResponse(delta);
  };
  const subagentResult = await runTestHarness({
    runId: "subagent-runtime-smoke",
    workspacePath: subagentRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "read-only",
    messages: [
      {
        role: "user",
        content: "Delegate a focused exploration of the persistence mechanism.",
      },
    ],
    onEvent: (event) => subagentEvents.push(event),
  });
  assert.equal(subagentResult.status, "completed");
  assert.equal(subagentResult.witness?.status, "completed");
  assert.equal(subagentResult.subagents.length, 1);
  assert.equal(subagentResult.subagents[0].status, "completed");
  assert.equal(
    subagentResult.steps.some(
      (step) => step.name === "delegate_subagent" && step.success,
    ),
    true,
  );
  assert.equal(
    subagentEvents.some((event) => event.type === "subagent.started"),
    true,
  );
  assert.equal(
    subagentEvents.some((event) => event.type === "subagent.completed"),
    true,
  );

  let backgroundParentRequests = 0;
  let backgroundChildRequests = 0;
  const backgroundEvents = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const requestMessages = body.messages || [];
    const systemText = String(requestMessages[0]?.content || "");
    if (/explore subagent/i.test(systemText)) {
      backgroundChildRequests += 1;
      const hasToolResult = requestMessages.some(
        (message) => message.role === "tool",
      );
      return createSseResponse(
        hasToolResult
          ? { content: "Background exploration found the event journal." }
          : createToolDelta("background-read-1", "read_file", {
              path: "architecture.txt",
            }),
      );
    }
    backgroundParentRequests += 1;
    const hasCollectedResults = requestMessages.some(
      (message) =>
        message.role === "user" &&
        /automatically collected the remaining background subagents/.test(
          String(message.content || ""),
        ),
    );
    const hasDelegationResult = requestMessages.some(
      (message) =>
        message.role === "tool" &&
        /"background":true/.test(String(message.content || "")),
    );
    if (hasCollectedResults) {
      return createSseResponse({
        content: "The background evidence was collected before delivery.",
      });
    }
    if (hasDelegationResult) {
      return createSseResponse({
        content: "The parent completed independent work.",
      });
    }
    return createSseResponse(
      createToolDelta("delegate-background-1", "delegate_subagent", {
        role: "explore",
        task: "Inspect architecture.txt in the background.",
        scope: ["architecture.txt"],
        background: true,
        max_rounds: 4,
      }),
    );
  };
  const backgroundSubagentResult = await runTestHarness({
    runId: "background-subagent-runtime-smoke",
    workspacePath: subagentRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "read-only",
    messages: [
      {
        role: "user",
        content: "Explore persistence in the background, then report it.",
      },
    ],
    onEvent: (event) => backgroundEvents.push(event),
  });
  assert.equal(backgroundSubagentResult.status, "completed");
  assert.equal(backgroundSubagentResult.subagents.length, 1);
  assert.equal(backgroundSubagentResult.subagents[0].status, "completed");
  assert.equal(backgroundParentRequests, 3);
  assert.equal(backgroundChildRequests, 2);
  assert.equal(
    backgroundEvents.some(
      (event) => event.type === "subagent.backgrounded",
    ),
    true,
  );
  assert.equal(
    backgroundEvents.some(
      (event) => event.type === "subagent.collected" && event.automatic,
    ),
    true,
  );

  const reviewedVersions = new Map();
  const selfCheckChanges = new Map([
    [
      "src/app.js",
      {
        path: "src/app.js",
        beforeContent: "old\n",
        afterContent: "first revision\n",
      },
    ],
  ]);
  assert.deepEqual(
    getPendingSelfCheckPaths(selfCheckChanges, reviewedVersions),
    ["src/app.js"],
  );
  reviewedVersions.set("src/app.js", "first revision\n");
  assert.deepEqual(
    getPendingSelfCheckPaths(selfCheckChanges, reviewedVersions),
    [],
  );
  selfCheckChanges.get("src/app.js").afterContent =
    "second revision\n";
  assert.deepEqual(
    getPendingSelfCheckPaths(selfCheckChanges, reviewedVersions),
    ["src/app.js"],
    "a file changed during self-check must be re-read",
  );

  await writeFile(
    join(testRoot, "package.json"),
    JSON.stringify({
      name: "runtime-self-check-fixture",
      scripts: {
        test: "node --check checked.js",
      },
    }),
    "utf8",
  );
  const scriptedModelResponses = [
    createToolDelta("plan-1", "update_plan", {
      explanation: "先实现，再验证并交付。",
      steps: [
        {
          id: "implement",
          title: "实现并检查模块",
          status: "in_progress",
          detail: "创建文件并完成所需修改",
        },
        {
          id: "verify",
          title: "运行验证与强制自检",
          status: "pending",
          detail: "重新读取修改并运行项目测试",
        },
      ],
    }),
    createToolDelta("write-1", "write_file", {
      path: "checked.js",
      content: "export const checked = true;\n",
    }),
    createToolDelta("plan-2", "update_plan", {
      explanation: "实现阶段完成，进入验证。",
      steps: [
        {
          id: "implement",
          title: "实现并检查模块",
          status: "completed",
          detail: "创建文件并完成所需修改",
        },
        {
          id: "verify",
          title: "运行验证与强制自检",
          status: "in_progress",
          detail: "重新读取修改并运行项目测试",
        },
      ],
    }),
    createToolDelta("search-1", "search_text", {
      path: ".",
      query: "checked = true",
      case_sensitive: true,
    }),
    createToolDelta("patch-1", "apply_patch", {
      path: "checked.js",
      old_text: "checked = true",
      new_text: "checked = 'reviewed'",
    }),
    { content: "实现与分段自检均已完成。" },
  ];
  let scriptedResponseIndex = 0;
  let transientFailureInjected = false;
  let stagedReviewRound = 0;
  let stagedVerifyRound = 0;
  let understandingCuratorRound = 0;
  const harnessEvents = [];
  globalThis.fetch = async (_url, options = {}) => {
    const requestBody = JSON.parse(options.body || "{}");
    const systemPrompt = String(requestBody.messages?.[0]?.content || "");
    if (/AporiaX review subagent/.test(systemPrompt)) {
      stagedReviewRound += 1;
      return createSseResponse(
        stagedReviewRound % 2 === 1
          ? createToolDelta("staged-review-read", "read_file", {
              path: "checked.js",
            })
          : {
              content: JSON.stringify({
                verdict: "pass",
                checks: ["检查语法与导出结构"],
                findings: [],
                remaining_risks: [],
              }),
            },
      );
    }
    if (/AporiaX verify subagent/.test(systemPrompt)) {
      stagedVerifyRound += 1;
      return createSseResponse(
        stagedVerifyRound === 1
          ? createToolDelta("staged-verify-command", "run_command", {
              command: "npm run test",
              cwd: ".",
              reason: "执行项目提供的语法验证脚本。",
            })
          : {
              content: JSON.stringify({
                verdict: "pass",
                commands: [
                  {
                    command: "npm run test",
                    cwd: ".",
                    exit_code: 0,
                    passed: true,
                  },
                ],
                checks: ["项目测试通过"],
                remaining_risks: [],
              }),
            },
      );
    }
    if (/AporiaX curator subagent/.test(systemPrompt)) {
      understandingCuratorRound += 1;
      return createSseResponse(
        understandingCuratorRound === 1
          ? createToolDelta("understanding-read", "read_file", {
              path: "checked.js",
            })
          : {
              content: JSON.stringify({
                summary: "Record the verified checked module",
                changes: [
                  {
                    operation: "upsert",
                    category: "module",
                    content: "checked.js exports the reviewed marker used by the runtime fixture.",
                    confidence: 0.91,
                    evidence: [
                      {
                        type: "file",
                        reference: "checked.js",
                        detail: "Read after the progressive self-check passed.",
                      },
                    ],
                  },
                ],
              }),
            },
      );
    }
    if (!transientFailureInjected) {
      transientFailureInjected = true;
      return new Response(
        JSON.stringify({
          error: { message: "Temporary provider overload." },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const delta = scriptedModelResponses[scriptedResponseIndex];
    scriptedResponseIndex += 1;
    if (!delta) throw new Error("Unexpected extra model request.");
    return createSseResponse(delta);
  };
  const harnessResult = await runTestHarness({
    runId: "runtime-understanding-run",
    taskId: "runtime-understanding-task",
    workspacePath: testRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    approvalMode: "sandbox-auto",
    understandingDirectory: join(testRoot, "understanding-integration"),
    messages: [
      {
        role: "user",
        content: "创建一个经过自检的模块。",
      },
    ],
    requestApproval: async () => {
      throw new Error(
        "Docker commands must not request approval in sandbox auto-approval mode.",
      );
    },
    onEvent: (event) => harnessEvents.push(event),
  });
  assert.equal(harnessResult.status, "completed");
  assert.equal(harnessResult.understanding?.committed, true);
  assert.equal(harnessResult.understanding?.currentRevision, 1);
  assert.equal(
    harnessEvents.some((event) => event.type === "understanding.updated"),
    true,
    "verified task changes should create a shared Understanding revision",
  );
  assert.equal(harnessResult.plan?.steps?.length, 2);
  assert.equal(
    harnessEvents.some((event) => event.type === "plan.updated"),
    true,
    "structured plans should be projected as first-class runtime events",
  );
  assert.equal(harnessResult.selfCheck?.completed, true);
  assert.equal(harnessResult.selfCheck?.mode, "progressive");
  assert.equal(harnessResult.selfCheck?.seal?.segmentCount, 2);
  assert.equal(
    harnessResult.selfCheck?.segments?.every(
      (segment) => segment.verdict === "pass",
    ),
    true,
    "a changed file version must be reviewed again after a later patch",
  );
  assert.deepEqual(harnessResult.selfCheck?.reviewedFiles, [
    "checked.js",
  ]);
  assert.equal(harnessResult.selfCheck?.verification?.passed, true);
  assert.equal(
    await readFile(join(testRoot, "checked.js"), "utf8"),
    "export const checked = 'reviewed';\n",
  );
  assert.equal(scriptedResponseIndex, scriptedModelResponses.length);
  assert.equal(
    harnessEvents.some((event) => event.type === "response.retry"),
    true,
    "transient provider errors should be retried automatically",
  );
  assert.equal(
    harnessResult.steps.filter(
      (step) =>
        step.name === "complete_self_check" && step.success === false,
    ).length,
    0,
    "progressive self-check should not require the parent agent to re-read every file",
  );
  assert.equal(
    harnessResult.steps.some(
      (step) => step.name === "search_text" && step.success,
    ),
    true,
  );
  assert.equal(
    harnessResult.steps.some(
      (step) => step.name === "apply_patch" && step.success,
    ),
    true,
  );
  assert.equal(
    harnessEvents.some((event) => event.type === "turn.started"),
    true,
  );
  assert.equal(
    harnessEvents.some((event) => event.type === "turn.completed"),
    true,
  );
  assert.equal(
    harnessEvents.some(
      (event) =>
        event.type === "tool.started" &&
        event.tool === "write_file" &&
        event.path === "checked.js",
    ),
    true,
    "live tool events should identify the file currently being edited",
  );
  assert.equal(
    harnessEvents.some(
      (event) =>
        event.type === "subagent.tool.started" &&
        event.tool === "run_command" &&
        event.command === "npm run test",
    ),
    true,
    "live tool events should identify the command currently being verified",
  );
  assert.deepEqual(
    harnessEvents.map((event) => event.sequence),
    harnessEvents.map((_event, index) => index + 1),
    "Harness events should have a stable monotonic sequence",
  );

  const unifiedMemoryRoot = join(testRoot, "unified-understanding");
  const untouchedLegacyMemoryDirectory = join(
    testRoot,
    "untouched-legacy-memory",
  );
  const unifiedUnderstandingDirectory = join(
    testRoot,
    "unified-understanding-store",
  );
  await mkdir(unifiedMemoryRoot, { recursive: true });
  const legacyCompatibilityStore = await createProjectMemoryStore({
    baseDirectory: untouchedLegacyMemoryDirectory,
    workspaceRoot: unifiedMemoryRoot,
  });
  await legacyCompatibilityStore.remember({
    category: "architecture",
    content: "Legacy architecture facts remain available during migration.",
    evidence: "Legacy Project Memory fixture",
  });
  const legacyMemoryBeforeRun = await readFile(
    legacyCompatibilityStore.path,
    "utf8",
  );
  let unifiedParentRound = 0;
  const unifiedMemoryEvents = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const systemPrompt = String(body.messages?.[0]?.content || "");
    if (/AporiaX curator subagent/.test(systemPrompt)) {
      return createSseResponse({
        content: JSON.stringify({
          summary: "Remember the explicit response preference",
          changes: [
            {
              operation: "upsert",
              category: "preference",
              content: "Use concise Simplified Chinese responses for this project.",
              confidence: 0.93,
              evidence: [
                {
                  type: "user",
                  reference: "Current user request",
                  detail: "The user explicitly requested this durable preference.",
                },
              ],
            },
          ],
        }),
      });
    }
    unifiedParentRound += 1;
    return createSseResponse(
      unifiedParentRound === 1
        ? createToolDelta("stage-preference", "remember_project_fact", {
            category: "preference",
            content: "Use concise Simplified Chinese responses for this project.",
            evidence: "Current user request",
          })
        : {
            content:
              "The preference was proposed and will be committed only after Curator review.",
          },
    );
  };
  const unifiedMemoryResult = await runTestHarness({
    runId: "unified-understanding-run",
    taskId: "unified-understanding-task",
    workspacePath: unifiedMemoryRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    memoryDirectory: untouchedLegacyMemoryDirectory,
    understandingDirectory: unifiedUnderstandingDirectory,
    messages: [
      {
        role: "user",
        content:
          "Remember that this project should use concise Simplified Chinese responses.",
      },
    ],
    onEvent: (event) => unifiedMemoryEvents.push(event),
  });
  assert.equal(unifiedMemoryResult.status, "completed");
  assert.equal(unifiedMemoryResult.understanding?.committed, true);
  assert.equal(
    unifiedMemoryEvents.some(
      (event) => event.type === "understanding.candidate.staged",
    ),
    true,
    "the compatibility memory tool should stage an Understanding candidate",
  );
  assert.equal(
    unifiedMemoryEvents.some(
      (event) => event.type === "understanding.updated",
    ),
    true,
    "a user-backed candidate should be committed by the automated Curator flow",
  );
  assert.equal(
    await readFile(legacyCompatibilityStore.path, "utf8"),
    legacyMemoryBeforeRun,
    "legacy Project Memory must be imported without modifying its original file",
  );
  const unifiedUnderstanding = await createProjectUnderstandingStore({
    baseDirectory: unifiedUnderstandingDirectory,
    workspaceRoot: unifiedMemoryRoot,
  });
  assert.equal(unifiedUnderstanding.snapshot().facts.length, 2);
  assert.deepEqual(
    new Set(
      unifiedUnderstanding.snapshot().facts.map((fact) => fact.category),
    ),
    new Set(["architecture", "preference"]),
  );

  const autoSelfCheckRoot = join(testRoot, "auto-self-check");
  await mkdir(autoSelfCheckRoot, { recursive: true });
  const autoSelfCheckResponses = [
    createToolDelta("auto-write", "write_file", {
      path: "auto.js",
      content: "export const ready = true;\n",
    }),
    createToolDelta("auto-check-early", "complete_self_check", {
      summary: "准备提交自检。",
      checks: ["检查导出"],
      improvements: [],
      remaining_risks: [],
    }),
    createToolDelta("auto-read", "read_file", {
      path: "auto.js",
    }),
    createToolDelta("auto-check-complete", "complete_self_check", {
      summary: "已重新读取并检查文件。",
      checks: ["导出语法和内容正确"],
      improvements: [],
      remaining_risks: [],
    }),
    { content: "自动自检已完成。" },
  ];
  let autoSelfCheckIndex = 0;
  const autoSelfCheckEvents = [];
  globalThis.fetch = async () => {
    const delta = autoSelfCheckResponses[autoSelfCheckIndex];
    autoSelfCheckIndex += 1;
    if (!delta) throw new Error("Unexpected extra auto self-check request.");
    return createSseResponse(delta);
  };
  const autoSelfCheckResult = await runTestHarness({
    workspacePath: autoSelfCheckRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    messages: [
      {
        role: "user",
        content: "创建文件并直接提交强制自检。",
      },
    ],
    onEvent: (event) => autoSelfCheckEvents.push(event),
  });
  assert.equal(autoSelfCheckResult.status, "completed");
  assert.equal(autoSelfCheckResult.selfCheck?.completed, true);
  assert.equal(
    autoSelfCheckResult.steps.find(
      (step) => step.name === "complete_self_check" && !step.success,
    )?.retry,
    true,
  );
  assert.equal(
    autoSelfCheckEvents.filter(
      (event) => event.type === "self_check.started",
    ).length,
    1,
  );

  const commandSnapshotRoot = join(testRoot, "command-snapshot");
  await mkdir(commandSnapshotRoot, { recursive: true });
  const commandSnapshotResponses = [
    createToolDelta("command-create", "run_command", {
      command:
        "node -e \"require('fs').writeFileSync('command-created.js','export const commandCreated = true;\\\\n')\"",
      cwd: ".",
      reason: "Create a file through the command sandbox.",
    }),
    { content: "The command-created file now exists." },
    createToolDelta("command-read", "read_file", {
      path: "command-created.js",
    }),
    createToolDelta("command-verify", "run_command", {
      command: "node --check command-created.js",
      cwd: ".",
      reason: "Verify the command-created JavaScript file.",
    }),
    createToolDelta("command-self-check", "complete_self_check", {
      summary: "Re-read and syntax-checked the command-created file.",
      checks: ["File content", "JavaScript syntax"],
      improvements: [],
      remaining_risks: [],
    }),
    { content: "Command-created change captured and verified." },
  ];
  let commandSnapshotIndex = 0;
  const commandSnapshotEvents = [];
  globalThis.fetch = async () => {
    const delta = commandSnapshotResponses[commandSnapshotIndex];
    commandSnapshotIndex += 1;
    if (!delta) {
      throw new Error("Unexpected extra command-snapshot request.");
    }
    return createSseResponse(delta);
  };
  const commandSnapshotResult = await runTestHarness({
    runId: "command-snapshot-run",
    workspacePath: commandSnapshotRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    approvalMode: "sandbox-auto",
    messages: [
      {
        role: "user",
        content: "Create and verify a JavaScript file using commands.",
      },
    ],
    onEvent: (event) => commandSnapshotEvents.push(event),
  });
  assert.equal(commandSnapshotResult.status, "completed");
  assert.equal(commandSnapshotResult.anchor?.id, "command-snapshot-run");
  assert.equal(commandSnapshotResult.anchor?.snapshotComplete, true);
  const commandCreatedChange = commandSnapshotResult.changes.find(
    (change) => change.path === "command-created.js",
  );
  assert.equal(commandCreatedChange?.created, true);
  assert.equal(commandCreatedChange?.beforeMissing, true);
  assert.equal(commandCreatedChange?.source, "workspace-snapshot");
  assert.equal(
    commandSnapshotEvents.some(
      (event) =>
        event.type === "file.changed" &&
        event.path === "command-created.js" &&
        event.source === "workspace-snapshot",
    ),
    true,
  );

  const wordArtifact = await createOfficeArtifact(
    "create_word_document",
    {
      path: "周报.docx",
      title: "项目周报",
      subtitle: "Office 工具冒烟测试",
      blocks: [
        { type: "heading", text: "本周进展", level: 1 },
        {
          type: "bullets",
          items: ["完成 Word 生成", "加入强制结构检查"],
        },
        {
          type: "table",
          headers: ["项目", "状态"],
          rows: [
            ["文档生成", "完成"],
            ["结构检查", "完成"],
          ],
        },
      ],
    },
  );
  const wordInspection = await inspectOfficeArtifact(
    wordArtifact.path,
    wordArtifact.buffer,
  );
  assert.equal(wordInspection.valid, true);
  assert.equal(wordInspection.headingCount, 1);
  assert.equal(wordInspection.tableCount, 1);
  assert.match(wordInspection.textPreview, /项目周报/);

  const presentationArtifact = await createOfficeArtifact(
    "create_presentation",
    {
      path: "复盘.pptx",
      title: "季度复盘",
      subtitle: "DeepAgent",
      slides: [
        {
          layout: "title",
          title: "季度复盘",
          subtitle: "关键成果与下一步",
        },
        {
          layout: "content",
          title: "核心进展",
          bullets: ["本地 Agent 循环", "Office 工件生成"],
        },
        {
          layout: "two_column",
          title: "后续计划",
          left_title: "近期",
          left_bullets: ["视觉渲染"],
          right_title: "长期",
          right_bullets: ["模板系统"],
        },
      ],
    },
  );
  const presentationInspection = await inspectOfficeArtifact(
    presentationArtifact.path,
    presentationArtifact.buffer,
  );
  assert.equal(presentationInspection.valid, true);
  assert.equal(presentationInspection.slideCount, 3);
  assert.match(presentationInspection.slides[1].text, /Office 工件生成/);

  const officeRoot = join(testRoot, "office-workspace");
  await mkdir(officeRoot, { recursive: true });
  const officeModelResponses = [
    createToolDelta("sheet-1", "create_spreadsheet", {
      path: "销售看板.xlsx",
      title: "销售看板",
      sheets: [
        {
          name: "数据",
          headers: ["月份", "销售额", "预测"],
          rows: [
            ["一月", 100, 110],
            ["二月", 120, 132],
          ],
          formulas: [
            {
              cell: "D2",
              formula: "B2*1.1",
              number_format: "0.00",
            },
          ],
          freeze_header: true,
          auto_filter: true,
        },
      ],
    }),
    { content: "表格已生成，准备自检。" },
    createToolDelta("inspect-sheet-1", "inspect_office_file", {
      path: "销售看板.xlsx",
    }),
    createToolDelta("office-check-missing-risk", "complete_self_check", {
      summary: "已完成结构检查。",
      checks: ["工作表、行列与公式可解析"],
      improvements: [],
      remaining_risks: [],
    }),
    createToolDelta("office-check-1", "complete_self_check", {
      summary: "已完成结构检查并记录视觉检查边界。",
      checks: ["工作表、行列与公式可解析"],
      improvements: [],
      remaining_risks: [
        "尚未在 Excel 中进行最终视觉渲染与版式检查。",
      ],
    }),
    { content: "Excel 工作簿已生成并通过结构自检。" },
  ];
  let officeResponseIndex = 0;
  globalThis.fetch = async () => {
    const delta = officeModelResponses[officeResponseIndex];
    officeResponseIndex += 1;
    if (!delta) throw new Error("Unexpected extra Office model request.");
    return createSseResponse(delta);
  };
  const officeHarnessResult = await runTestHarness({
    workspacePath: officeRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    messages: [
      {
        role: "user",
        content: "创建一份带公式的销售 Excel 工作簿。",
      },
    ],
  });
  assert.equal(officeHarnessResult.status, "completed");
  assert.equal(officeHarnessResult.selfCheck?.completed, true);
  assert.deepEqual(officeHarnessResult.selfCheck?.reviewedFiles, [
    "销售看板.xlsx",
  ]);
  assert.equal(officeHarnessResult.changes[0]?.binary, true);
  assert.equal(
    officeHarnessResult.steps.some(
      (step) =>
        step.name === "inspect_office_file" && step.success,
    ),
    true,
  );
  assert.equal(
    officeHarnessResult.steps.filter(
      (step) =>
        step.name === "complete_self_check" && !step.success,
    ).length,
    0,
    "Harness should add the missing Office visual risk without trapping the model in a retry loop",
  );
  assert.equal(
    officeHarnessResult.selfCheck?.remainingRisks.some((risk) =>
      /visual|render|layout|版式|渲染|视觉/i.test(risk),
    ),
    true,
  );
  assert.equal(officeResponseIndex, officeModelResponses.length);

  const officePreview = await readWorkspacePreview(
    officeRoot,
    "销售看板.xlsx",
  );
  assert.equal(officePreview.binary, true);
  assert.equal(officePreview.artifact.valid, true);
  assert.equal(officePreview.artifact.sheetCount, 1);
  assert.equal(officePreview.artifact.formulaCount, 1);

  const officeRevert = await revertWorkspaceChanges({
    workspacePath: officeRoot,
    changes: officeHarnessResult.changes,
  });
  assert.equal(officeRevert[0]?.success, true);
  await assert.rejects(access(join(officeRoot, "销售看板.xlsx")));

  const plainRoot = join(testRoot, "plain-workspace");
  await mkdir(plainRoot, { recursive: true });
  await writeFile(
    join(plainRoot, ".git"),
    "gitdir: Z:\\missing-aporiax-repository",
    "utf8",
  );
  const plainGitResponses = [
    createToolDelta("plain-git-status", "git_status", {}),
    {
      content:
        "✅ Git 检查不适用于当前目录。<svg><path d=\"M0 0\" /></svg>",
    },
  ];
  let plainGitResponseIndex = 0;
  globalThis.fetch = async () => {
    const delta = plainGitResponses[plainGitResponseIndex];
    plainGitResponseIndex += 1;
    if (!delta) throw new Error("Unexpected extra plain Git request.");
    return createSseResponse(delta);
  };
  const plainGitResult = await runTestHarness({
    workspacePath: plainRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "read-only",
    messages: [
      {
        role: "user",
        content: "检查这个目录的 Git 状态。",
      },
    ],
  });
  assert.equal(plainGitResult.status, "completed");
  assert.equal(plainGitResult.steps[0]?.success, true);
  assert.equal(plainGitResult.steps[0]?.skipped, true);
  assert.doesNotMatch(plainGitResult.content, /✅|<svg/i);

  const gitInit = spawnSync("git", ["init"], {
    cwd: testRoot,
    encoding: "utf8",
  });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  await writeFile(
    join(testRoot, "tracked.txt"),
    "baseline\n",
    "utf8",
  );
  const gitAdd = spawnSync("git", ["add", "tracked.txt"], {
    cwd: testRoot,
    encoding: "utf8",
  });
  assert.equal(gitAdd.status, 0, gitAdd.stderr);
  await writeFile(
    join(testRoot, "tracked.txt"),
    "changed\n",
    "utf8",
  );

  const gitModelResponses = [
    createToolDelta("git-status-1", "git_status", {}),
    createToolDelta("git-diff-1", "git_diff", {
      path: "tracked.txt",
      staged: false,
    }),
    { content: "Git inspection completed." },
  ];
  let gitResponseIndex = 0;
  globalThis.fetch = async () => {
    const delta = gitModelResponses[gitResponseIndex];
    gitResponseIndex += 1;
    if (!delta) throw new Error("Unexpected extra Git model request.");
    return createSseResponse(delta);
  };
  const gitHarnessResult = await runTestHarness({
    workspacePath: testRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "read-only",
    messages: [
      {
        role: "user",
        content: "Inspect the current Git changes without editing files.",
      },
    ],
  });
  assert.equal(gitHarnessResult.status, "completed");
  assert.equal(
    gitHarnessResult.steps.some(
      (step) => step.name === "git_status" && step.success,
    ),
    true,
  );
  assert.equal(
    gitHarnessResult.steps.some(
      (step) => step.name === "git_diff" && step.success,
    ),
    true,
  );
  assert.equal(gitResponseIndex, gitModelResponses.length);

  await mkdir(join(testRoot, "src"), { recursive: true });
  await writeFile(
    join(testRoot, "src", "example.js"),
    "export const value = 1;\n",
    "utf8",
  );

  const tree = await listWorkspaceTree(testRoot);
  assert(
    tree.entries.some(
      (entry) => entry.path === "src" && entry.type === "directory",
    ),
    "workspace root should expose only its immediate files and folders",
  );
  assert.equal(
    tree.entries.some((entry) => entry.path === "src/example.js"),
    false,
    "workspace listing should not eagerly flatten nested directories",
  );
  const sourceDirectory = await listWorkspaceTree(testRoot, "src");
  assert(
    sourceDirectory.entries.some(
      (entry) => entry.path === "src/example.js",
    ),
    "opening a directory should load its immediate children",
  );

  const preview = await readWorkspacePreview(
    testRoot,
    "src/example.js",
  );
  assert.match(preview.content, /value = 1/);

  await writeFile(join(testRoot, "reference.pdf"), pdfFixture);
  const pdfPreview = await readWorkspacePreview(
    testRoot,
    "reference.pdf",
  );
  assert.equal(pdfPreview.readOnly, true);
  assert.equal(pdfPreview.pageCount, 1);
  assert.match(pdfPreview.content, /Hello from PDF/);

  const savedPreview = await saveWorkspaceTextFile({
    workspacePath: testRoot,
    requestedPath: "src/example.js",
    content: "export const value = 2;\n",
    expectedContent: preview.content,
  });
  assert.match(savedPreview.content, /value = 2/);
  await assert.rejects(
    saveWorkspaceTextFile({
      workspacePath: testRoot,
      requestedPath: "src/example.js",
      content: "export const value = 3;\n",
      expectedContent: preview.content,
    }),
    /编辑器之外发生变化/,
  );

  await writeFile(
    join(testRoot, "src", "example.js"),
    "export const value = 2;\n",
    "utf8",
  );
  const restored = await revertWorkspaceChanges({
    workspacePath: testRoot,
    changes: [
      {
        path: "src/example.js",
        beforeContent: "export const value = 1;\n",
        afterContent: "export const value = 2;\n",
        created: false,
      },
    ],
  });
  assert.equal(restored[0]?.success, true);
  assert.equal(
    await readFile(join(testRoot, "src", "example.js"), "utf8"),
    "export const value = 1;\n",
  );

  await writeFile(join(testRoot, "created.txt"), "new\n", "utf8");
  const removed = await revertWorkspaceChanges({
    workspacePath: testRoot,
    changes: [
      {
        path: "created.txt",
        beforeContent: "",
        afterContent: "new\n",
        created: true,
      },
    ],
  });
  assert.equal(removed[0]?.success, true);
  await assert.rejects(access(join(testRoot, "created.txt")));

  const anchorDirectory = join(testRoot, "anchor-fixtures");
  await mkdir(join(anchorDirectory, "node_modules"), {
    recursive: true,
  });
  await writeFile(
    join(anchorDirectory, "history.txt"),
    "zero\n",
    "utf8",
  );
  await writeFile(
    join(anchorDirectory, "node_modules", "ignored.txt"),
    "ignored\n",
    "utf8",
  );
  const capturedAnchor = await captureWorkspaceState(anchorDirectory);
  assert.equal(capturedAnchor.files.has("history.txt"), true);
  assert.equal(
    capturedAnchor.files.has("node_modules/ignored.txt"),
    false,
  );

  await writeFile(
    join(anchorDirectory, "history.txt"),
    "two\n",
    "utf8",
  );
  const crossTurnRestore = await restoreWorkspaceAnchor({
    workspacePath: anchorDirectory,
    checkpoints: [
      {
        id: "newer-turn",
        changes: [
          {
            path: "history.txt",
            beforeContent: "one\n",
            afterContent: "two\n",
            beforeMissing: false,
            afterMissing: false,
          },
        ],
      },
      {
        id: "older-turn",
        changes: [
          {
            path: "history.txt",
            beforeContent: "zero\n",
            afterContent: "one\n",
            beforeMissing: false,
            afterMissing: false,
          },
        ],
      },
    ],
  });
  assert.equal(crossTurnRestore.success, true);
  assert.deepEqual(crossTurnRestore.restoredCheckpoints, [
    "newer-turn",
    "older-turn",
  ]);
  assert.equal(
    await readFile(join(anchorDirectory, "history.txt"), "utf8"),
    "zero\n",
  );

  await writeFile(
    join(anchorDirectory, "history.txt"),
    "external edit\n",
    "utf8",
  );
  const conflictingRestore = await restoreWorkspaceAnchor({
    workspacePath: anchorDirectory,
    checkpoints: [
      {
        id: "conflicting-turn",
        changes: [
          {
            path: "history.txt",
            beforeContent: "zero\n",
            afterContent: "two\n",
            beforeMissing: false,
            afterMissing: false,
          },
        ],
      },
    ],
  });
  assert.equal(conflictingRestore.success, false);
  assert.equal(conflictingRestore.reason, "preflight-conflict");
  assert.equal(
    await readFile(join(anchorDirectory, "history.txt"), "utf8"),
    "external edit\n",
  );

  await writeFile(
    join(anchorDirectory, "created-by-agent.txt"),
    "generated\n",
    "utf8",
  );
  const structuralRestore = await restoreWorkspaceAnchor({
    workspacePath: anchorDirectory,
    checkpoints: [
      {
        id: "structural-turn",
        changes: [
          {
            path: "created-by-agent.txt",
            beforeContent: "",
            afterContent: "generated\n",
            beforeMissing: true,
            afterMissing: false,
            created: true,
          },
          {
            path: "deleted-by-agent.txt",
            beforeContent: "original\n",
            afterContent: "",
            beforeMissing: false,
            afterMissing: true,
            deleted: true,
          },
        ],
      },
    ],
  });
  assert.equal(structuralRestore.success, true);
  await assert.rejects(
    access(join(anchorDirectory, "created-by-agent.txt")),
  );
  assert.equal(
    await readFile(
      join(anchorDirectory, "deleted-by-agent.txt"),
      "utf8",
    ),
    "original\n",
  );

  console.log("Runtime smoke test passed.");
} finally {
  globalThis.fetch = originalFetch;
  const resolvedRoot = resolve(testRoot);
  const resolvedWorkspace = resolve(".");
  if (
    !resolvedRoot.startsWith(`${resolvedWorkspace}${sep}`) ||
    !basename(resolvedRoot).startsWith(".runtime-smoke-")
  ) {
    throw new Error("Refusing to remove a test directory outside the workspace.");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}
