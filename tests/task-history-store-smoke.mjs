import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TASK_JSON_BYTES,
  TASK_JSON_TOO_LARGE,
  createTaskHistoryStore,
} from "../electron/task-history-store.js";
import { BLOB_SCHEME, attachmentImageSrc } from "../src/attachments.js";

assert.equal(MAX_TASK_JSON_BYTES, 200 * 1024 * 1024);

const png = Buffer.from("hello-image");
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

function imageTask(id = "task-small") {
  return {
    id,
    title: "small",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "look",
        attachments: [
          {
            id: "img-1",
            kind: "image",
            name: "a.png",
            type: "image/png",
            dataUrl,
          },
        ],
      },
    ],
  };
}

const root = await mkdtemp(join(tmpdir(), "aporiax-task-history-"));
try {
  assert.equal(await createTaskHistoryStore(root).loadTasks(), null);

  const store = createTaskHistoryStore(root, { maxTaskJsonBytes: 8_000 });
  const small = imageTask();
  const doc = {
    id: "task-doc",
    messages: [
      {
        id: "m2",
        role: "user",
        content: "doc",
        attachments: [
          {
            id: "doc-1",
            kind: "document",
            name: "notes.txt",
            type: "text/plain",
            content: "extracted document text stays here",
            data: Buffer.from("original-bytes"),
          },
        ],
      },
    ],
  };

  const first = await store.saveTasks([small, doc]);
  assert.equal(first.ok, true);
  assert.deepEqual([...first.saved].sort(), ["task-doc", "task-small"]);

  const loaded = await store.loadTasks();
  const loadedSmall = loaded.find((task) => task.id === "task-small");
  const attachment = loadedSmall.messages[0].attachments[0];
  assert.ok(attachment.hash);
  assert.equal(attachment.dataUrl, undefined);
  assert.equal(
    attachmentImageSrc(attachment),
    `${BLOB_SCHEME}://${attachment.hash}`,
  );

  const blob = await store.readBlob(attachment.hash);
  assert.equal(blob.buffer.toString(), "hello-image");

  const [hydrated] = await store.hydrateMessages(loadedSmall.messages);
  assert.match(hydrated.attachments[0].dataUrl, /^data:image\/png;base64,/);

  const loadedDoc = loaded.find((task) => task.id === "task-doc");
  const docAttachment = loadedDoc.messages[0].attachments[0];
  assert.equal(docAttachment.content, "extracted document text stays here");
  assert.equal(docAttachment.data, undefined);
  assert.ok(docAttachment.hash);
  const original = await store.readBlob(docAttachment.hash);
  assert.equal(original.buffer.toString(), "original-bytes");

  const huge = {
    id: "task-huge",
    messages: [{ id: "h1", role: "user", content: "x".repeat(20_000) }],
  };
  const mixed = await store.saveTasks([small, doc, huge]);
  assert.equal(mixed.ok, false);
  assert.ok(mixed.saved.includes("task-small"));
  assert.ok(mixed.saved.includes("task-doc"));
  assert.equal(mixed.failed[0].id, "task-huge");
  assert.equal(mixed.failed[0].code, TASK_JSON_TOO_LARGE);
  const afterMixed = await store.loadTasks();
  assert.equal(
    afterMixed.some((task) => task.id === "task-huge"),
    false,
  );

  const grown = {
    ...small,
    messages: [
      ...small.messages,
      { id: "grow", role: "assistant", content: "y".repeat(20_000) },
    ],
  };
  const grownResult = await store.saveTasks([grown, doc]);
  assert.equal(grownResult.ok, false);
  assert.equal(grownResult.failed[0].id, "task-small");
  assert.equal(grownResult.failed[0].code, TASK_JSON_TOO_LARGE);
  const stillSmall = (await store.loadTasks()).find(
    (task) => task.id === "task-small",
  );
  assert.equal(stillSmall.messages.length, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}

const legacyRoot = await mkdtemp(join(tmpdir(), "aporiax-task-legacy-"));
try {
  await writeFile(
    join(legacyRoot, "aporiax-tasks.json"),
    JSON.stringify([
      {
        id: "legacy-1",
        messages: [
          {
            id: "m",
            role: "user",
            content: "hi",
            attachments: [
              { kind: "image", name: "a.png", type: "image/png", dataUrl },
            ],
          },
        ],
      },
    ]),
  );
  const migrated = await createTaskHistoryStore(legacyRoot).loadTasks();
  assert.equal(migrated[0].id, "legacy-1");
  assert.ok(migrated[0].messages[0].attachments[0].hash);
  assert.equal(migrated[0].messages[0].attachments[0].dataUrl, undefined);
  await readFile(join(legacyRoot, "aporiax-tasks.json.migrated"), "utf8");
} finally {
  await rm(legacyRoot, { recursive: true, force: true });
}

console.log("task history store smoke: PASS");
