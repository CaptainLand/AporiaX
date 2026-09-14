import assert from "node:assert/strict";
import {
  COMPOSER_ATTACHMENT_DRAG,
  beginComposerAttachmentDrag,
  composerAttachmentFromDataTransfer,
  endComposerAttachmentDrag,
  isComposerAttachmentDrag,
  presentComposerAttachment,
} from "../src/attachments.js";
import {
  BUILDER_COUNT_CHOICES,
  DEFAULT_BUILDER_LIMIT,
  MAX_BUILDERS,
  normalizeBuilderCount,
} from "../electron/harness/builder-count.js";
import { isCollapsedDropEdge } from "../src/workbench/drop-edge.js";

assert.deepEqual(BUILDER_COUNT_CHOICES, [0, 2, 3, 4]);
assert.equal(MAX_BUILDERS, 4);
assert.equal(normalizeBuilderCount(undefined, DEFAULT_BUILDER_LIMIT), 2);
assert.equal(normalizeBuilderCount(0), 0);
assert.equal(normalizeBuilderCount(1), 2);
assert.equal(normalizeBuilderCount(9), 4);

assert.equal(isComposerAttachmentDrag({ types: ["Files"] }), false);
assert.equal(isComposerAttachmentDrag({ types: [COMPOSER_ATTACHMENT_DRAG] }), true);

const transfer = {
  types: [],
  effectAllowed: "",
  setData(type) {
    this.types.push(type);
  },
};
const image = {
  id: "img-1",
  kind: "image",
  name: "shot.png",
  dataUrl: "data:image/png;base64,xxxx",
};
beginComposerAttachmentDrag({ dataTransfer: transfer }, image);
assert.equal(transfer.effectAllowed, "copy");
assert.equal(composerAttachmentFromDataTransfer(transfer), image);
endComposerAttachmentDrag();
assert.equal(composerAttachmentFromDataTransfer(transfer), null);

const opened = [];
const notices = [];
const workbench = {
  expand: () => opened.push("expand"),
  openImage: (src, name) => opened.push(["image", src, name]),
  openFile: (path) => opened.push(["file", path]),
};

assert.equal(
  presentComposerAttachment(workbench, image, (message) => notices.push(message)),
  true,
);
assert.deepEqual(opened, ["expand", ["image", image.dataUrl, "shot.png"]]);

opened.length = 0;
assert.equal(
  presentComposerAttachment(
    workbench,
    { id: "doc-1", kind: "document", name: "brief.pdf", path: "D:/brief.pdf" },
    (message) => notices.push(message),
  ),
  true,
);
assert.deepEqual(opened, ["expand", ["file", "D:/brief.pdf"]]);

opened.length = 0;
assert.equal(
  presentComposerAttachment(
    workbench,
    { id: "doc-2", kind: "document", name: "pasted.pdf" },
    (message) => notices.push(message),
  ),
  false,
);
assert.equal(opened[0], "expand");
assert.match(notices.at(-1), /没有本地路径/);

const workspaceRect = { width: 1000, right: 1000 };
assert.equal(isCollapsedDropEdge({ clientX: 900 }, workspaceRect), true);
assert.equal(isCollapsedDropEdge({ clientX: 400 }, workspaceRect), false);

console.log("composer attachment drag smoke: PASS");
