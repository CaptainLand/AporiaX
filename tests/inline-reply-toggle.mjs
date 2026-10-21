import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkInlineReplyToggle } from '../src/conversation/remark-inline-reply-toggle.js';

const render = (content, enabled = true) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, ...(enabled ? [remarkInlineReplyToggle] : [])],
  components: { 'aporiax-reply-toggle': () => React.createElement('button', { type: 'button', 'aria-label': '展开回复' }) },
}, content));
for (const content of ['已完成。', '第一段。\n\n最后一段。', '- 第一项。\n- 最后一项。', '- 外层。\n  - 最后一项。', '已完成，参见 [说明](https://example.invalid/)。', '已删除 `calc.html`。', '# 结束', '正文。\n\n[link]: https://example.invalid/']) {
  const html = render(content);
  assert.equal((html.match(/<button/g) || []).length, 1, 'Exactly one UI-only toggle');
  assert.match(html, /<button[^>]*><\/button><\/(?:p|li|h1)>/, 'Prose toggle is inline in the final paragraph/list item/heading');
  assert.doesNotMatch(html, /<(?:a|code)[^>]*>[^<]*<button/, 'Do not insert a control inside a link or inline code');
}
assert.match(render('```js\nconst value = true;\n```'), /<\/pre>\s*<p><button/, 'Code endings get an adjacent prose fallback');
assert.match(render('| A | B |\n| - | - |\n| 1 | 2 |'), /<\/table>\s*<p><button/, 'Table endings stay intact');
assert.doesNotMatch(render('没有补充内容。', false), /button|aporiax-reply-toggle/);
assert.match(render('```txt\n<aporiax-reply-toggle>\n```'), /&lt;aporiax-reply-toggle&gt;/, 'Code examples never become UI controls');
console.log('PASS inline reply toggle: final prose/list/nested list/link/code/heading, intact block fallbacks and no placeholder when absent.');
