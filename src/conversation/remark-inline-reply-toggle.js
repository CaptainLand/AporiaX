// Append a UI-only slot to the final prose block. Do not put controls inside a
// link/code node or flatten Markdown to force an inline layout.
export function remarkInlineReplyToggle() {
  return tree => {
    function endingProse(node) {
      if (node.type === 'paragraph' || node.type === 'heading') return node;
      if (!['root', 'list', 'listItem', 'blockquote'].includes(node.type)) return null;
      const last = node.children?.findLast(child => !['definition', 'footnoteDefinition'].includes(child.type));
      return last ? endingProse(last) : null;
    }
    const slot = { type: 'replyToggle', data: { hName: 'aporiax-reply-toggle' }, children: [] };
    const paragraph = endingProse(tree);
    if (paragraph) paragraph.children.push(slot);
    else tree.children.push({ type: 'paragraph', children: [slot] });
  };
}
