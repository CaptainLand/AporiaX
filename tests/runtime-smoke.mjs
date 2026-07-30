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
import { join, resolve } from "node:path";
import {
  getPendingSelfCheckPaths,
  listWorkspaceTree,
  readWorkspacePreview,
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

const testRoot = await mkdtemp(join(resolve("."), ".runtime-smoke-"));
const originalFetch = globalThis.fetch;

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
    createToolDelta("write-1", "write_file", {
      path: "checked.js",
      content: "export const checked = true;\n",
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
    { content: "初步完成。" },
    createToolDelta("check-too-early", "complete_self_check", {
      summary: "尚未复读。",
      checks: ["语法"],
      improvements: [],
      remaining_risks: [],
    }),
    createToolDelta("read-1", "read_file", {
      path: "checked.js",
    }),
    createToolDelta("check-before-verification", "complete_self_check", {
      summary: "已复读，但尚未运行验证。",
      checks: ["检查语法"],
      improvements: [],
      remaining_risks: [],
    }),
    createToolDelta("verify-1", "run_command", {
      command: "npm run test",
      cwd: ".",
      reason: "执行项目提供的语法验证脚本。",
    }),
    createToolDelta("check-1", "complete_self_check", {
      summary: "已重新读取并检查本轮修改。",
      checks: ["检查语法与导出结构"],
      improvements: [],
      remaining_risks: [],
    }),
    { content: "实现与强制自检均已完成。" },
  ];
  let scriptedResponseIndex = 0;
  let transientFailureInjected = false;
  const harnessEvents = [];
  globalThis.fetch = async () => {
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
  const harnessResult = await runHarness({
    apiKey: "sk-runtime-smoke-test",
    workspacePath: testRoot,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    messages: [
      {
        role: "user",
        content: "创建一个经过自检的模块。",
      },
    ],
    requestApproval: async () => ({ approved: true }),
    onEvent: (event) => harnessEvents.push(event),
  });
  assert.equal(harnessResult.status, "completed");
  assert.equal(harnessResult.selfCheck?.completed, true);
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
    2,
    "self-check completion must be rejected before re-read and verification",
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
  assert.deepEqual(
    harnessEvents.map((event) => event.sequence),
    harnessEvents.map((_event, index) => index + 1),
    "Harness events should have a stable monotonic sequence",
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
  const autoSelfCheckResult = await runHarness({
    apiKey: "sk-runtime-smoke-test",
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
  const officeHarnessResult = await runHarness({
    apiKey: "sk-runtime-smoke-test",
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
  const plainGitResult = await runHarness({
    apiKey: "sk-runtime-smoke-test",
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
  const gitHarnessResult = await runHarness({
    apiKey: "sk-runtime-smoke-test",
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
    tree.entries.some((entry) => entry.path === "src/example.js"),
    "workspace tree should include nested files",
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

  console.log("Runtime smoke test passed.");
} finally {
  globalThis.fetch = originalFetch;
  const resolvedRoot = resolve(testRoot);
  const resolvedWorkspace = resolve(".");
  if (!resolvedRoot.startsWith(`${resolvedWorkspace}\\`)) {
    throw new Error("Refusing to remove a test directory outside the workspace.");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}
