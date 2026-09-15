import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { parseSkillDocument, createSkillRegistry } from "../electron/harness/skills/registry.js";
import { prepareSkillRequest, prepareSkillMessage } from "../electron/skill-runtime.js";
import { sanitizeConversation } from "../electron/runtime/conversation.js";
import { reconcileHumanConstraints } from "../electron/runtime/human-constraints.js";
import { readSkillResource, CURATED_SKILLS_DIRECTORY } from "../electron/skill-resources.js";
import { installCatalogSkill, importUserSkill, rollbackUserSkill, saveMcpServer, importMcpConfiguration, setMcpServerEnabled, extensionLibrarySnapshot } from "../electron/extension-library.js";
import { normalizeMcpServer, loadMcpConfiguration, publicMcpServerSummary } from "../electron/mcp-config.js";
import { createMcpRuntime } from "../electron/mcp-runtime.js";
import { HarnessCapabilityRegistry } from "../electron/harness/capability-registry.js";
import { createOfficeArtifact, inspectOfficeArtifact } from "../electron/office-tools.js";
import { wordImageInfo } from "../electron/word-images.js";
import { createNativeToolExecutor } from "../electron/runtime/native-tool-executor.js";
import { runHarness } from "../electron/agent-runtime.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-ecosystem-"));
const userDataDirectory = join(root, "user"), workspaceRoot = join(root, "workspace");
const options = { workspaceRoot, userSkillsDirectory: join(userDataDirectory, "skills") };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  await mkdir(workspaceRoot);
  const folded = parseSkillDocument("---\nname: a\ndescription: >-\n  Chinese Word\n  typography\nlicense: MIT\nmetadata:\n  version: 2.1\n  nested: {scope: local}\nallowed-tools: [Bash, Read]\n---\nRead references.");
  assert.equal(folded.description, "Chinese Word typography");
  assert.equal(folded.version, "2.1"); assert.equal(folded.metadata.nested.scope, "local");
  assert(folded.compatibilityWarnings.length);
  for (const yaml of ["name: one\nname: two", "name: !custom hi", "name: ok\nmetadata: &x {cycle: *x}", "name: ok\nmetadata: {constructor: bad}", "name: ok\ndescription: {bad: object}"]) {
    assert.throws(() => parseSkillDocument(`---\n${yaml}\n---\nInstructions`));
  }
  assert.throws(() => parseSkillDocument("---\nname: unclosed"), /Unclosed/);
  const catalog = await createSkillRegistry().catalog();
  for (const name of ["word-professional", "document-themes", "systematic-debugging"]) {
    const skill = catalog.find((item) => item.name === name); assert(skill, name);
    const source = JSON.parse(await readFile(join(skill.packageRoot, ".aporiax-source.json")));
    assert.match(source.commit, /^[a-f0-9]{40}$/);
    for (const file of source.files) assert.equal(hash(await readFile(join(skill.packageRoot, file.local))), file.sha256);
  }
  const registry = createSkillRegistry();
  const prompt = "@skill:word-professional 请写中文报告，不要上传。";
  const prepared = await prepareSkillRequest({ workspacePath: workspaceRoot, messages: [{ role: "user", content: prompt }] }, { registry });
  assert.equal(prepared.messages[0].content, prompt);
  const normalized = sanitizeConversation(prepared.messages);
  assert.equal(normalized.length, 2); assert.equal(normalized[1].aporiaSource, "retrieval");
  assert.equal(reconcileHumanConstraints(normalized, normalized).entries.length, 1);
  assert.match(normalized[1].content, /read_skill_resource/);
  const steered = await prepareSkillMessage({ role: "user", content: prompt }, workspaceRoot, { registry });
  assert.deepEqual(sanitizeConversation([steered]), normalized);
  const legacy = { ...prepared.messages[0], content: prompt + "\n\n" + prepared.messages[0].aporiaSkillContext };
  assert.deepEqual(sanitizeConversation([legacy]), normalized);
  const read = await readSkillResource(options, { skill: "word-professional", path: "references/cjk_typography.md", limit: 100 });
  assert.equal(read.content.length, 100); assert.equal(read.nextOffset, 100);
  const next = await readSkillResource(options, { skill: "word-professional", path: "references/cjk_typography.md", offset: 100 });
  assert.equal(read.content + next.content, await readFile(join(CURATED_SKILLS_DIRECTORY, "word-professional/references/cjk_typography.md"), "utf8"));
  for (const path of ["../private.txt", "C:/private.txt", "/private.txt", "references/../../private.txt"]) {
    await assert.rejects(readSkillResource(options, { skill: "word-professional", path }), /escapes/);
  }
  const hermes = await installCatalogSkill({ userDataDirectory, catalogId: "skill.hermes-docx" });
  const hermesRoot = join(userDataDirectory, "skills", "hermes-docx");
  assert(hermes.installed); assert.match(await readFile(join(hermesRoot, "scripts/docx_common.py"), "utf8"), /def /);
  const hermesSource = JSON.parse(await readFile(join(hermesRoot, ".aporiax-source.json")));
  for (const file of hermesSource.files) assert.equal(hash(await readFile(join(hermesRoot, file.local))), file.sha256);
  const sourceDirectory = join(root, "source"); await mkdir(sourceDirectory);
  const skillText = (version) => `---\nname: custom-skill\nversion: ${version}\nauto: false\n---\nVersion ${version}.`;
  await writeFile(join(sourceDirectory, "SKILL.md"), skillText(1));
  await writeFile(join(sourceDirectory, "ref.txt"), "v1");
  await importUserSkill({ userDataDirectory, sourceDirectory });
  await writeFile(join(sourceDirectory, "SKILL.md"), skillText(2));
  await writeFile(join(sourceDirectory, "ref.txt"), "v2");
  await importUserSkill({ userDataDirectory, sourceDirectory });
  assert((await extensionLibrarySnapshot({ userDataDirectory })).installed.skillPackages.find((s) => s.name === "custom-skill").canRollback);
  await rollbackUserSkill({ userDataDirectory, name: "custom-skill" });
  assert.equal(await readFile(join(userDataDirectory, "skills/custom-skill/ref.txt"), "utf8"), "v1");
  await importUserSkill({ userDataDirectory, sourceDirectory }); // rollback keeps original source identity
  const stable = await readFile(join(userDataDirectory, "skills/custom-skill/SKILL.md"), "utf8");
  await writeFile(join(sourceDirectory, "SKILL.md"), "---\nname: invalid!");
  await assert.rejects(importUserSkill({ userDataDirectory, sourceDirectory }));
  assert.equal(await readFile(join(userDataDirectory, "skills/custom-skill/SKILL.md"), "utf8"), stable);
  const other = join(root, "different-source"); await mkdir(other);
  await writeFile(join(other, "SKILL.md"), skillText(3));
  await assert.rejects(importUserSkill({ userDataDirectory, sourceDirectory: other }), /different source/);
  const link = join(userDataDirectory, "skills/custom-skill/private-link");
  await symlink(workspaceRoot, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readSkillResource(options, { skill: "custom-skill", path: "private-link" }), /symbolic/);
  await rm(link); // remove only the test link, never its target
  const invalidDir = join(userDataDirectory, "skills", "invalid"); await mkdir(invalidDir);
  await writeFile(join(invalidDir, "SKILL.md"), "---\nname: invalid!");
  assert.equal((await registry.catalog({ userSkillsDirectory: options.userSkillsDirectory })).diagnostics.length, 1);

  const argv = ["--header", "one", "--header", "two", "", " spaced "];
  assert.deepEqual(normalizeMcpServer({ id: "args", command: "node", args: argv }).args, argv);
  assert.throws(() => normalizeMcpServer({ id: "bad", command: "node", args: ["${input:apiKey}"] }), /Unsupported MCP placeholder/);
  const privateServer = normalizeMcpServer({ id: "private", transport: "streamable-http", url: "https://example.test/mcp?token=secret-value", headers: { Authorization: "Bearer secret-value" } });
  assert(!JSON.stringify(publicMcpServerSummary(privateServer)).includes("secret-value"));
  const missing = normalizeMcpServer({ id: "missing", command: "node", env: { API: "${NOT_PRESENT}" } }, { environment: {} });
  const absentRuntime = createMcpRuntime({ servers: [missing], clientFactory() { throw new Error("must not launch"); } });
  assert.match((await absentRuntime.discover()).errors[0].error, /MCP_ENV_MISSING/); await absentRuntime.close();
  const events = [];
  const failed = createMcpRuntime({ servers: [privateServer], emit: (event) => events.push(event), clientFactory: () => ({ async connect() { throw new Error("Denied Bearer secret-value"); }, async close() {} }), transportFactory: () => ({ async close() {} }) });
  assert(!JSON.stringify(await failed.discover()).includes("secret-value")); assert(!JSON.stringify(events).includes("secret-value")); await failed.close();
  const capabilityRegistry = new HarnessCapabilityRegistry();
  const client = { async connect() {}, async close() {}, getServerCapabilities: () => ({ tools: {} }), async listTools() { return { tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }; } };
  const runtime = createMcpRuntime({ servers: [normalizeMcpServer({ id: "ready", command: "node" })], clientFactory: () => client, transportFactory: () => ({ async close() {} }), capabilityRegistry, scopeId: "test" });
  assert.equal((await runtime.discover()).tools.length, 1); client.onclose();
  assert.equal(runtime.active, false); assert.equal(runtime.toolCatalog().length, 0); assert.equal(capabilityRegistry.list().length, 0);
  assert.match(runtime.serverSummaries()[0].error, /DISCONNECTED/); await runtime.close();
  await Promise.all(Array.from({ length: 8 }, (_, i) => saveMcpServer({ userDataDirectory, server: { id: `parallel-${i}`, command: "node", enabled: false } })));
  assert.equal((await loadMcpConfiguration({ userDataDirectory })).allServers.length, 8);
  const sourcePath = join(root, "mcp.json");
  await writeFile(sourcePath, JSON.stringify({ mcpServers: { "parallel-0": { command: "overwrite" }, imported: { command: "node", args: argv }, legacy: { type: "sse", url: "https://example.test/sse" } } }));
  const imported = await importMcpConfiguration({ userDataDirectory, sourcePath });
  assert.equal(imported.imported.length, 1); assert.equal(imported.imported[0].enabled, false); assert.equal(imported.errors.length, 2);
  assert.equal((await loadMcpConfiguration({ userDataDirectory })).allServers.find((s) => s.id === "parallel-0").command, "node");
  await saveMcpServer({ userDataDirectory, server: { id: "token", transport: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer private-header" } } });
  await setMcpServerEnabled({ userDataDirectory, id: "token", enabled: false });
  assert.equal((await loadMcpConfiguration({ userDataDirectory })).allServers.find((s) => s.id === "token").headers.Authorization, "Bearer private-header");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==", "base64");
  const imageInfo = wordImageInfo(png); assert.equal(imageInfo.width, 1);
  assert.throws(() => wordImageInfo(Buffer.alloc(40)), /PNG/);
  const input = { path: "report.docx", title: "中文报告", template: "business-report", header: "AporiaX", footer: "内部预览", page_numbers: true, blocks: [
    { type: "heading", text: "结果", level: 1 }, { type: "paragraph", runs: [{ text: "Hello " }, { text: "world", bold: true }, { text: " 中文", italic: true }] },
    { type: "table", headers: ["项目", "状态"], rows: [["排版", "待视觉检查"]] }, { type: "image", path: "pixel.png", caption: "示意图" },
  ] };
  const artifact = await createOfficeArtifact("create_word_document", { ...input, _wordImages: new Map([["pixel.png", imageInfo]]) });
  const zip = await JSZip.loadAsync(artifact.buffer);
  const xml = await zip.file("word/document.xml").async("string"), styles = await zip.file("word/styles.xml").async("string");
  assert.match(xml, /Hello /); assert.match(xml, /world/); assert.match(xml, /w:eastAsia="Microsoft YaHei"/); assert.match(styles, /Microsoft YaHei/);
  assert.match(xml, /w:w="11906"/); assert.match(xml, /w:tblHeader/); assert.match(xml, /w:drawing/);
  const footer = await zip.file("word/footer1.xml").async("string"); assert.match(footer, /NUMPAGES/); assert.match(footer, /PAGE/);
  assert.equal(artifact.artifact.visualQa, "not-rendered"); assert.equal(artifact.artifact.imageCount, 1);
  assert.equal((await inspectOfficeArtifact(input.path, artifact.buffer)).valid, true);
  const boundary = async (_root, path) => { const target = resolve(workspaceRoot, path); const child = relative(workspaceRoot, target); if (child.startsWith("..") || isAbsolute(child)) throw new Error("outside workspace"); return target; };
  const unused = () => { throw new Error("Unexpected unrelated tool dependency"); };
  const execute = createNativeToolExecutor({ verifyExistingTarget: boundary, verifyWritableTarget: boundary, searchWorkspaceText: unused, calculateLineChanges: unused, runGitCommand: unused });
  await writeFile(join(workspaceRoot, "pixel.png"), png);
  const generated = await execute({ toolName: "create_word_document", workspaceRoot, input });
  assert.equal(generated.modelResult.artifact.imageCount, 1);
  await assert.rejects(execute({ toolName: "create_word_document", workspaceRoot, input: { ...input, blocks: [{ type: "image", path: "../private.png" }] } }), /outside workspace/);
  assert.equal((await execute({ toolName: "read_skill_resource", ...options, input: { skill: "hermes-docx", path: "scripts/docx_common.py" } })).modelResult.source, "skill-resource");
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  try {
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body); modelCalls++;
      assert(modelCalls <= 2, "reading a Skill resource must not loop or ask for unrelated approvals");
      assert(body.tools.some((tool) => tool.function.name === "read_skill_resource"));
      if (modelCalls === 1) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-package", type: "function", function: { name: "read_skill_resource", arguments: JSON.stringify({ skill: "custom-skill", path: "ref.txt" }) } }] } }] }) + '\n\ndata: [DONE]\n\n');
      const output = body.messages.find((item) => item.role === "tool");
      assert.match(output.content, /v2/); assert.match(output.content, /skill-resource/);
      return new Response('data: {"choices":[{"delta":{"content":"Read complete."}}]}\n\ndata: [DONE]\n\n');
    };
    const result = await runHarness({ runId: "skill-resource-e2e", workspacePath: workspaceRoot, userSkillsDirectory: options.userSkillsDirectory,
      provider: { id: "test", name: "test", vendor: "openai", baseUrl: "https://test.invalid/v1", apiKey: "fake", models: [{ id: "test", supportsTools: true, contextWindow: 32000 }] },
      modelId: "test", permission: "read-only", messages: [{ role: "user", content: "Read ref.txt from custom-skill and report; do not edit files." }],
      requestApproval: () => { throw new Error("Resource read unexpectedly required approval"); },
    });
    assert.equal(result.status, "completed"); assert.equal(modelCalls, 2);
  } finally { globalThis.fetch = originalFetch; }
  console.log("Extension ecosystem: YAML, provenance, references, pinned packages, rollback, concurrency, MCP state/secrets/import and Word formatting/path boundaries: PASS");
} finally { await rm(root, { recursive: true, force: true }); }
