import assert from "node:assert/strict";
import {
  APPROVAL_TOAST_TIMEOUT_MS,
  approvalToastClosedByTimeout,
  approvalToastCopy,
} from "../electron/approval-toast-state.js";

assert.equal(APPROVAL_TOAST_TIMEOUT_MS, 10_000);
assert.equal(approvalToastClosedByTimeout(9_999, false), false);
assert.equal(approvalToastClosedByTimeout(10_000, false), true);
assert.equal(approvalToastClosedByTimeout(12_000, true), false, "a click dismisses immediately and is not a timeout");

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

const deleteScope = { kind: 'delete-file', directory: '.', extension: '.html' };
const grant = approvalToastCopy({ canRememberForRun: true, similarApproval: deleteScope });
assert.equal(grant.similar, '本轮允许类似操作');
assert.match(grant.similarHint, /工作区根目录.+\.html.+不含子目录/);
assert.equal(approvalToastCopy({ canRememberForRun: false, similarApproval: deleteScope }).similar, undefined);
assert.equal(approvalToastCopy({ canRememberForRun: true, similarApproval: { ...deleteScope, directory: 'x'.repeat(125) } }).similar, undefined);

console.log("approval toast smoke: PASS");
