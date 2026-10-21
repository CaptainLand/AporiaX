// Presentation only: retain limitations and failures, without report labels or
// duplicate disclosure content. Fenced examples must remain byte-for-byte text.
export function conversationalReplyDetails(value) {
  if (typeof value !== 'string') return '';
  let fence = null;
  return value.split(/\r?\n/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/^\s*(?:#{1,6}\s+)?(?:\*\*)?(?:验证与限制|验证说明|视觉效果未(?:由我)?验证|Verification and limitations|Verification note|Visual effects unverified)(?:\*\*)?\s*(?:[：:]\s*(?:\*\*)?\s*|$)/i, '');
  }).join('\n').trim();
}

export function supportingReply(summary, ...parts) {
  // Keep fenced blocks intact, including blank lines and repeated code lines.
  const chunks = text => /^ {0,3}(?:`{3,}|~{3,})/m.test(text) ? [text] : text.split(/\n\s*\n/);
  const main = conversationalReplyDetails(summary);
  const visible = new Set([main, ...chunks(main)].map(part => part.trim()));
  return parts.flatMap(part => chunks(conversationalReplyDetails(part))).filter(part => {
    const key = part.trim();
    if (!key || visible.has(key)) return false;
    visible.add(key);
    return true;
  }).join('\n\n').trim();
}
