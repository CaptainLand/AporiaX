import assert from "node:assert/strict";
import {
  formatToolStepDetail,
  normalizeDocumentAttachment,
  normalizeImageAttachment,
  sanitizeConversation,
  sanitizeFinalAnswer,
} from "../electron/runtime/conversation.js";

assert.equal(normalizeImageAttachment({ dataUrl: "https://example.com/a.png" }), null);
assert.deepEqual(
  normalizeImageAttachment({ dataUrl: "data:image/png;base64,AAAA" }),
  { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
);

const document = normalizeDocumentAttachment({
  kind: "document",
  name: "guide.pdf",
  format: "PDF",
  pageCount: 2,
  content: "hello",
  truncated: true,
});
assert.match(document, /guide\.pdf/);
assert.match(document, /hello/);
assert.match(document, /截断/);

const history = sanitizeConversation(
  [
    { role: "assistant", content: "old", status: "completed" },
    { role: "assistant", content: "ignored", status: "running" },
    {
      role: "user",
      content: "inspect this",
      status: "completed",
      attachments: [
        { kind: "image", dataUrl: "data:image/png;base64,AAAA" },
        { kind: "document", name: "a.txt", format: "TXT", content: "document context" },
      ],
    },
  ],
  { supportsImages: true },
);
assert.equal(history.length, 2);
assert.equal(history[1].role, "user");
assert(Array.isArray(history[1].content));
assert.match(history[1].content[0].text, /document context/);
assert.equal(history[1].content[1].type, "image_url");

const textOnly = sanitizeConversation(
  [
    {
      role: "user",
      content: "inspect",
      status: "completed",
      attachments: [{ kind: "image", dataUrl: "data:image/png;base64,AAAA" }],
    },
  ],
  { supportsImages: false },
);
assert.match(textOnly[0].content, /不支持读取/);

assert.equal(
  sanitizeFinalAnswer("hello 😀  \nworld"),
  "hello\nworld",
);
assert.match(
  formatToolStepDetail("read_file", { error: "Invalid arguments for read_file." }, "en"),
  /Invalid tool arguments/,
);
assert.match(
  formatToolStepDetail("complete_self_check", {
    error: "Run at least one detected project verification command before completing self-check.",
  }),
  /项目验证命令/,
);

const interruptedHistory = sanitizeConversation([
  { id: "old-user", role: "user", content: "continue the old UI test" },
  {
    id: "old-assistant",
    role: "assistant",
    sourceUserId: "old-user",
    content: "stopped",
    status: "interrupted",
  },
  { id: "new-user", role: "user", content: "What time is it?" },
]);
assert.deepEqual(
  interruptedHistory,
  [{ role: "user", content: "What time is it?" }],
  "an interrupted assistant and its source request must be removed together",
);

const retriedHistory = sanitizeConversation([
  { id: "retry-user", role: "user", content: "inspect app.js" },
  {
    role: "assistant",
    sourceUserId: "retry-user",
    content: "failed",
    status: "failed",
  },
  {
    role: "assistant",
    sourceUserId: "retry-user",
    content: "inspection completed",
    status: "completed",
  },
  { id: "next-user", role: "user", content: "Summarize the result" },
]);
assert.equal(retriedHistory.length, 3);
assert.equal(retriedHistory[0].content, "inspect app.js");

const greetingHistory = sanitizeConversation([
  { id: "done-user", role: "user", content: "build the old feature" },
  {
    role: "assistant",
    sourceUserId: "done-user",
    content: "done",
    status: "completed",
  },
  { id: "hello-user", role: "user", content: "你好" },
]);
assert.deepEqual(greetingHistory, [{ role: "user", content: "你好" }]);

console.log("conversation runtime smoke: PASS");
