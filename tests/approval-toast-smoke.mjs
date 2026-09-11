import assert from "node:assert/strict";
import {
  APPROVAL_TOAST_TIMEOUT_MS,
  approvalToastClosedByTimeout,
  approvalToastCopy,
} from "../electron/approval-toast-state.js";

assert.equal(APPROVAL_TOAST_TIMEOUT_MS, 5_000);
assert.equal(approvalToastClosedByTimeout(4_999, false), false);
assert.equal(approvalToastClosedByTimeout(5_000, false), true);
assert.equal(approvalToastClosedByTimeout(8_000, true), false, "a click dismisses immediately and is not a timeout");

const zh = approvalToastCopy({
  title: "运行命令",
  command: "npm test --watch",
});
assert.equal(zh.eyebrow, "等待确认");
assert.equal(zh.title, "运行命令");
assert.match(zh.body, /npm test/);
assert.equal(zh.approve, "确认");
assert.equal(zh.deny, "拒绝");

const en = approvalToastCopy({ reason: "Write file src/app.js" }, "en");
assert.equal(en.eyebrow, "Needs confirmation");
assert.equal(en.approve, "Approve");
assert.equal(en.deny, "Deny");
assert.match(en.body, /Write file/);

const long = approvalToastCopy({ command: "x".repeat(400) });
assert.equal(long.body.length, 160);

console.log("approval toast smoke: PASS");
