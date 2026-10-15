import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness } from "../electron/agent-runtime-core.js";
import { createRunControl } from "../electron/runtime/run-control.js";
import { installMcpSteeringProvider, parseMcpMentions, selectConfiguredMcpServers } from "../electron/mcp-mentions.js";
import { withDurableRun } from "../electron/runtime/durable-run.js";

const root = await mkdtemp(join(tmpdir(), "aporia-real-extension-loop-"));
const savedFetch = globalThis.fetch;
const serverCode = [
  "const {Server}=require('@modelcontextprotocol/sdk/server/index.js');",
  "const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');",
  "const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');",
  "const s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});",
  "s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Array.from({length:40},(_,i)=>({name:'tool_'+String(i).padStart(2,'0'),description:'Fixture read',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}))}));",
  "s.setRequestHandler(CallToolRequestSchema,async r=>({content:[{type:'text',text:r.params.name==='tool_39'?'FIXTURE_NOT_FOUND':'LOCAL_STDIO_OK'}],isError:r.params.name==='tool_39'}));",
  "s.connect(new StdioServerTransport());",
].join("\n");
const server = { id: "fixture", name: "Fixture", enabled: true, transport: "stdio", command: process.execPath, args: ["-e", serverCode],
  cwd: process.cwd(), env: {}, timeoutMs: 5000, autoApproveReadOnly: true };
const provider = { id: "fixture", name: "Fixture", vendor: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fake", models: [{ id: "test", supportsTools: true, contextWindow: 64000 }] };
const call = (name, args) => new Response("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }) + "\n\ndata: [DONE]\n\n");
const answer = text => new Response("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\ndata: [DONE]\n\n");
try {
  const skills = join(root, "skills"); await mkdir(join(skills, "asteroid"), { recursive: true });
  await writeFile(join(skills, "asteroid", "SKILL.md"), "---\nname: asteroid\ndescription: asteroid fixture diagnostics\nauto: false\n---\nRead references.txt before querying Fixture MCP. No edits.");
  await writeFile(join(skills, "asteroid", "references.txt"), "REFERENCE_CONTENT: tool_39 can report not found; tool_00 is a safe alternative.");
  let count = 0, steered = false, resolutions = 0;
  const initialServer = { ...server, id: "alpha" };
  let configuredServers = [initialServer, server];
  installMcpSteeringProvider(async (request, current) => {
    resolutions++;
    if (request.messages.length) assert(parseMcpMentions(request.messages[0].content).includes("fixture"));
    return selectConfiguredMcpServers(request, current, configuredServers);
  });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); count++; assert(count <= 7);
    const last = body.messages.filter(message => message.role === "tool").at(-1);
    if (count === 1) {
      assert(!body.tools.some(tool => tool.function.name.startsWith("mcp__fixture")));
      return call("search_skills", { query: "asteroid fixture" });
    }
    if (count === 2) {
      assert.match(last.content, /asteroid/);
      assert(body.tools.some(tool => tool.function.name === "mcp__fixture__tool_00"), "mid-run trusted MCP server must become callable");
      return call("read_skill_resource", { skill: "asteroid", path: "SKILL.md" });
    }
    if (count === 3) { assert.match(last.content, /references.txt/); return call("read_skill_resource", { skill: "asteroid", path: "references.txt" }); }
    if (count === 4) { assert.match(last.content, /REFERENCE_CONTENT/); return call("mcp_search_tools", { query: "tool_39", server: "fixture" }); }
    if (count === 5) { assert(body.tools.some(tool => tool.function.name === "mcp__fixture__tool_39")); return call("mcp__fixture__tool_39", {}); }
    if (count === 6) { assert.equal(JSON.parse(last.content).isError, true); assert.match(last.content, /FIXTURE_NOT_FOUND/); return call("mcp__fixture__tool_00", {}); }
    assert.match(last.content, /LOCAL_STDIO_OK/);
    return answer("Read the installed workflow and reference. The first lookup failed; the safe alternate lookup returned LOCAL_STDIO_OK.");
  };
  const events = [];
  const control = createRunControl();
  const consume = control.consumeSteering;
  control.consumeSteering = () => {
    if (count > 0 && !steered) { steered = true; control.enqueueSteering({ id: "guidance", role: "user", content: "Also use (@mcp:fixture)，只读核对。" }); }
    return consume();
  };
  const contexts = {};
  const result = await withDurableRun({ operation: async () => {}, context: async (id, json) => { contexts[id] = JSON.parse(json); } }, () => runHarness({ runId: "real-extension-loop", workspacePath: root, userSkillsDirectory: skills, provider, modelId: "test", permission: "read-only", mcpServers: [initialServer],
    messages: [{ role: "user", content: "Use @mcp:alpha. Discover the asteroid fixture workflow, read it and follow the reference. Do not edit files." }],
    control,
    onEvent: event => events.push(event), requestApproval: async () => { throw new Error("Unexpected write approval"); },
  }));
  assert.equal(result.status, "completed", JSON.stringify(result.steps));
  assert.equal(count, 7); assert.equal(resolutions, 1);
  assert.equal(result.steps.find(step => step.name === "mcp__fixture__tool_39").success, false);
  assert.equal(result.steps.find(step => step.name === "mcp__fixture__tool_00").success, true);
  assert(events.some(event => event.type === "mcp.tool.completed" && event.success === false));
  assert.deepEqual(contexts["real-extension-loop"].selectedMcpServerIds, ["alpha", "fixture"]);
  assert.equal(JSON.stringify(contexts).includes(serverCode), false, "Server commands/configuration must not enter recovery history");
  for (const enabled of [true, false]) {
    configuredServers = enabled ? [initialServer, server] : [initialServer];
    let resumedRequests = 0;
    globalThis.fetch = async (_url, init) => {
      resumedRequests++;
      const body = JSON.parse(init.body);
      assert(body.messages.some(message => String(message.content).includes("@mcp:fixture")), "Steering history survives recovery");
      assert.equal(body.tools.some(tool => tool.function.name === "mcp__fixture__tool_00"), enabled, "Restore late selection only if current configuration permits it");
      return answer("Resumed from confirmed history; no tools replayed.");
    };
    const resumed = await runHarness({ runId: "restored-" + enabled, workspacePath: root, provider, modelId: "test", permission: "read-only", mcpServers: [initialServer],
      messages: [{ role: "user", content: "Continue @mcp:alpha original task." }], recoveryContext: { runId: "real-extension-loop", contexts } });
    assert.equal(resumed.status, "completed", resumed.content); assert.equal(resumedRequests, 1); assert.equal(resumed.steps.length, 0);
  }
  // Global installed Skills must remain callable without a project workspace.
  count = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); count++; assert(count <= 2);
    if(count === 1) { assert(body.tools.some(tool => tool.function.name === "read_skill_resource")); return call("read_skill_resource", { skill: "asteroid", path: "references.txt" }); }
    assert.match(body.messages.filter(message => message.role === "tool").at(-1).content, /REFERENCE_CONTENT/);
    return answer("Global Skill resource read.");
  };
  const globalResult = await runHarness({ runId: "global-skill-loop", userSkillsDirectory: skills, provider, modelId: "test", permission: "read-only", messages: [{ role: "user", content: "Read asteroid references.txt only." }] });
  assert.equal(globalResult.status, "completed"); assert.equal(count, 2);
  console.log("Real SDK stdio + model loop: Skill discovery → full instructions → resource → mid-run MCP attach → deferred tool schema → error feedback → recovery read → completion; durable late-server restoration with revoked configuration; no-workspace Skill loop: PASS");
} finally {
  globalThis.fetch = savedFetch; installMcpSteeringProvider(null);
  await rm(root, { recursive: true, force: true });
}
