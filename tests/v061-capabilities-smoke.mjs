import assert from "node:assert/strict";
import { createPersistentProcessManager } from "../electron/runtime/process-runtime.js";
import { parseMcpMentions, selectMentionedMcpServers } from "../electron/mcp-mentions.js";
import { formatWorkspaceMentionToken } from "../src/agent-process-model.js";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

assert.deepEqual(parseMcpMentions("Use @mcp:docs and @mcp:browser "), ["docs", "browser"]);
const selected = selectMentionedMcpServers(
  { prompt: "Ask @mcp:docs ", messages: [] },
  [{ id: "docs" }, { id: "browser" }],
);
assert.deepEqual(selected.servers.map((server) => server.id), ["docs"]);
assert.equal(formatWorkspaceMentionToken("skill:frontend-review"), "@skill:frontend-review");
assert.equal(formatWorkspaceMentionToken("mcp:docs"), "@mcp:docs");

const manager = createPersistentProcessManager();
try {
  const started = manager.start({
    command: "node tests/fixtures/persistent-process-fixture.cjs",
    cwd: process.cwd(),
  });
  assert.match(started.processId, /^proc_/);
  let first = { output: "", cursor: 0 };
  for (let attempt = 0; attempt < 30 && !first.output.includes("ready"); attempt += 1) {
    await wait(30);
    first = manager.read({ processId: started.processId, cursor: 0 });
  }
  assert.match(first.output, /ready/);
  const wrote = manager.write({ processId: started.processId, data: "hello\n" });
  assert(wrote.bytesWritten > 0);
  let second = { output: "" };
  for (let attempt = 0; attempt < 30 && !second.output.includes("echo:hello"); attempt += 1) {
    await wait(30);
    second = manager.read({ processId: started.processId, cursor: first.cursor });
  }
  assert.match(second.output, /echo:hello/);
  assert.equal((await manager.kill(started.processId)).status, "stopping");
} finally {
  await manager.closeAll();
}

console.log("v0.6.1 capabilities smoke: PASS");
