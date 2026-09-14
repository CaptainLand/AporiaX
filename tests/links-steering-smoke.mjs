import assert from "node:assert/strict";
import { classifyLink, messageLinkUrl, splitAutolinkBoundary } from "../electron/link-target.js";
import { completeWithSteering } from "../electron/runtime/steerable-completion.js";
import { splitSteeredReply } from "../src/state/steering-messages.js";

assert.equal(classifyLink("D:/项目/安装包.exe").target, "D:/项目/安装包.exe");
assert.equal(classifyLink("/D:/项目/安装包.exe").target, "D:/项目/安装包.exe");
assert.equal(classifyLink("file:///D:/项目/安装包.exe").target, "D:/项目/安装包.exe");
assert.equal(classifyLink("<D:/项目/a.png>").target, "D:/项目/a.png");
assert.equal(classifyLink("file:///D:/my%20project/a.js:12").line, 12);
assert.equal(classifyLink("src/main.jsx#L42").line, 42);
assert.equal(classifyLink("https://example.com:443/a").kind, "web");
const swallowed = "http://localhost:8080/todo.html（仅本机可访问；8080";
assert.equal(classifyLink(swallowed).href, "http://localhost:8080/todo.html");
assert.deepEqual(splitAutolinkBoundary(swallowed, swallowed), {
  href: "http://localhost:8080/todo.html",
  label: "http://localhost:8080/todo.html",
  suffix: "（仅本机可访问；8080",
});
assert.deepEqual(
  splitAutolinkBoundary("http://www.example.com（说明", "www.example.com（说明"),
  { href: "http://www.example.com", label: "www.example.com", suffix: "（说明" },
);
assert.equal(splitAutolinkBoundary("https://example.com/a", "说明文字"), null);

const { unified } = await import("unified");
const { default: remarkParse } = await import("remark-parse");
const { default: remarkGfm } = await import("remark-gfm");
const { remarkAutolinkBoundary } = await import("../src/conversation/remark-autolink-boundary.js");
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkAutolinkBoundary);
const tree = markdown.runSync(markdown.parse(`见 ${swallowed} 结束`));
const paragraph = tree.children.find((node) => node.type === "paragraph");
const link = paragraph.children.find((node) => node.type === "link");
const after = paragraph.children.find((node) => node.type === "text" && String(node.value).includes("仅本机"));
assert.equal(link.url, "http://localhost:8080/todo.html");
assert.equal(link.children[0].value, "http://localhost:8080/todo.html");
assert.match(after.value, /^（仅本机可访问；8080/);

for (const bad of ["javascript:alert(1)", "data:text/html,hi", "cmd:run", "file://server/share", "//server/share", "file:///C:/a%00b"]) assert.equal(classifyLink(bad), null, bad);
assert.equal(messageLinkUrl("javascript:alert(1)"), "");

const run = { taskId: "t", assistantId: "a" };
let tasks = [{ id: "t", messages: [
  { id: "u", role: "user", content: "build" },
  { id: "a", role: "assistant", status: "running", content: "Original progress", progressUpdates: [{ content: "Plan" }], sourceUserId: "u", route: [{ id: "r" }], witness: { id: "w" } },
  { id: "s", role: "user", content: "Change it", steeringStatus: "pending" },
  { id: "later", role: "user", content: "Another request", steeringStatus: "pending" },
] }];
tasks = splitSteeredReply(tasks, run, { messageIds: ["s"] });
assert.deepEqual(tasks[0].messages.map((m) => m.id), ["u", "a-before-s", "s", "a", "later"]);
assert.equal(tasks[0].messages[1].content, "Original progress");
assert.equal(tasks[0].messages[1].witness, undefined);
assert.equal(tasks[0].messages[3].sourceUserId, "u");
assert.equal(tasks[0].messages[3].witness.id, "w");
assert.equal(tasks[0].messages[3].content, "");
assert.deepEqual(splitSteeredReply(tasks, run, { messageIds: ["s"] }), tasks, "duplicate acknowledgement is idempotent");
tasks[0].messages[3].content = "New progress";
tasks = splitSteeredReply(tasks, run, { messageIds: ["later"] });
assert.deepEqual(tasks[0].messages.map((m) => m.id), ["u", "a-before-s", "s", "a-before-later", "later", "a"]);

function control() {
  let queued = false;
  const listeners = new Set();
  return { hasSteering: () => queued, onSteering(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    steer() { queued = true; for (const fn of listeners) fn(); }, get listeners() { return listeners.size; } };
}
const ctl = control();
const root = new AbortController();
const events = [];
const provider = { complete: ({ signal, onStreamEvent }) => new Promise((resolve, reject) => {
  signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError", usage: { total_tokens: 7 } })), { once: true });
  onStreamEvent({ type: "response.delta", delta: "Kept output" });
  queueMicrotask(() => ctl.steer());
}) };
const interrupted = await completeWithSteering({ provider, control: ctl, signal: root.signal, body: {}, onEvent: (event) => events.push(event) });
assert.equal(interrupted.interrupted, true);
assert.equal(interrupted.message.content, "Kept output");
assert.equal(interrupted.usage.total_tokens, 7);
assert.equal(root.signal.aborted, false, "steering must not kill the run or its tools");
assert.equal(ctl.listeners, 0);
assert.equal(events.length, 1);
const stopCtl = control();
const stop = new AbortController();
await assert.rejects(completeWithSteering({ control: stopCtl, signal: stop.signal, body: {}, provider: { complete: ({ signal }) => new Promise((resolve, reject) => {
  signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })));
  stop.abort();
}) } }), { name: "AbortError" });
assert.equal(stopCtl.listeners, 0);
const ok = await completeWithSteering({ provider: { complete: async () => ({ message: { content: "done" }, usage: null }) }, control: control(), body: {} });
assert.equal(ok.interrupted, false);
console.log("Links and steering smoke: PASS");
