import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessCoreClient } from "../electron/harness/core-client.js";
import { createHarnessCoreServer } from "../electron/harness/core-server.js";
import { createHarnessTaskRuntime } from "../electron/harness/task-runtime.js";
import { closeRunJournalStore } from "../electron/run-store.js";

const root = await mkdtemp(join(tmpdir(), "aporiax-task-rpc-"));
const coreEvents = [];
const runtime = createHarnessTaskRuntime({ dataDirectory: root });
runtime.setTaskStarter((request, context) =>
  runtime.start({
    runId: request.runId,
    taskId: request.taskId,
    clientId: context.clientId,
    detached: context.detached,
    metadata: { prompt: "rpc smoke" },
    onEvent: () => {
      throw new Error("detached client disappeared");
    },
    execute: async ({ signal, control, emit }) => {
      emit({ type: "turn.started" });
      while (!signal.aborted) {
        await control.waitIfPaused(signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Object.assign(new Error("interrupted"), { name: "AbortError" });
    },
  }),
);

const kernel = {
  version: 2,
  taskRuntime: runtime,
  capabilities: () => ({ taskRpc: true }),
  capabilitiesRegistry: { summary: () => ({}), list: () => [] },
  events: {
    emit: (event) => coreEvents.push(event),
    history: () => [],
    snapshot: () => [],
  },
  agents: { list: () => [] },
  plugins: { list: () => [] },
  skills: { list: () => [] },
  sessions: { list: () => [] },
  snapshot: () => ({ version: 2 }),
};

const server = createHarnessCoreServer({ kernel });
try {
  await server.listen();
  const client = createHarnessCoreClient({
    baseUrl: server.url,
    token: server.token,
  });

  assert.equal((await client.health()).capabilities.taskRpc, true);
  const started = await client.startTask({ runId: "rpc-1", taskId: "task-1" });
  assert.equal(started.status, "running");
  assert.equal((await client.task("rpc-1")).active, true);

  await client.pauseTask("rpc-1");
  assert.equal((await client.task("rpc-1")).paused, true);
  await client.steerTask("rpc-1", { content: "continue with the new constraint" });
  await client.resumeTask("rpc-1");
  await client.interruptTask("rpc-1");

  await new Promise((resolve) => setTimeout(resolve, 40));
  const snapshot = await client.tasks();
  assert.equal(snapshot.active.length, 0);

  const recovered = await client.task("rpc-1");
  assert.equal(recovered.active, false);
  assert(
    recovered.recovery.events.some((event) => event.type === "steering.queued"),
  );
  assert(
    recovered.recovery.events.some((event) => event.type === "run.finished"),
  );

  console.log("task runtime RPC smoke: PASS");
} finally {
  await server.close().catch(() => undefined);
  await closeRunJournalStore(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
