import assert from "node:assert/strict";
import {
  extractLinkedFiles,
  filesToPresent,
  isPreviewableWorkbenchPath,
} from "../electron/workbench/present.js";

assert.equal(isPreviewableWorkbenchPath("docs/report.docx"), true);
assert.equal(isPreviewableWorkbenchPath("shot.png"), true);
assert.equal(isPreviewableWorkbenchPath("src/app.js"), true);
assert.equal(isPreviewableWorkbenchPath("deck.pptx"), false);
assert.equal(isPreviewableWorkbenchPath("sheet.xlsx"), false);

assert.deepEqual(
  extractLinkedFiles("Done. See [Report](docs/report.docx) and [site](https://example.com/app)."),
  [{ path: "docs/report.docx", line: 1 }],
);
assert.deepEqual(
  extractLinkedFiles("Open [code](<src/main.js:12>)"),
  [{ path: "src/main.js", line: 12 }],
);
assert.equal(extractLinkedFiles("Visit https://localhost:5173").length, 0);

const linked = filesToPresent({
  content: "交付 [首页](src/index.js) 和 [样式](src/app.css)。",
  changes: [
    { path: "src/index.js" },
    { path: "src/app.css" },
    { path: "src/hidden.js" },
  ],
});
assert.deepEqual(linked.map((item) => item.path), ["src/index.js", "src/app.css"]);

const ignoredEdits = filesToPresent({
  content: "Updated the parser and ran tests.",
  changes: [
    { path: "src/parser.js" },
    { path: "src/parser.test.js" },
  ],
});
assert.deepEqual(ignoredEdits, []);

const standalone = filesToPresent({
  content: "Word 文档已完成。",
  changes: [{ path: "out/brief.docx", created: true, beforeMissing: true }],
});
assert.deepEqual(standalone, [{ path: "out/brief.docx", line: 1 }]);

const mixed = filesToPresent({
  content: "Also generated a document.",
  changes: [
    { path: "src/app.js" },
    { path: "out/brief.docx", created: true, beforeMissing: true },
  ],
});
assert.deepEqual(mixed, []);

console.log("workbench present smoke: PASS");
