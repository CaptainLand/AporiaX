import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MAX_SCAN_BYTES = 256 * 1024 * 1024;
/** Bounded-memory UTF-8 reader. Offsets/ranges count normalized JS characters;
 * SHA-256 hashes original bytes, so patch preconditions still match the file.
 * Reading the complete stream is needed for the hash, not for buffering it. */
export async function readTextPage(path, input = {}, maximumChars = 120000, signal) {
  const limit = Math.max(1, Math.min(maximumChars, Number(input.limit) || 60000));
  const lineMode = Number.isInteger(input.start_line) || Number.isInteger(input.end_line);
  const from = Math.max(1, input.start_line || 1);
  const to = Math.max(from, input.end_line || from + 999);
  const offset = Math.max(0, Number(input.offset) || 0);
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size > MAX_SCAN_BYTES) throw new Error('Text reader accepts regular files up to 256 MiB; narrow or split larger logs.');
    const hash = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let pendingCR = '', totalChars = 0, line = 1, start = null, content = '', selectedChars = 0;
    let bytesRead = 0;
    function consume(raw) {
      const text = raw.replace(/\r\n/g, '\n');
      // Split bounded chunks, never whole unbounded lines.
      const parts = text.split(/(?<=\n)/);
      for (const part of parts) {
        const eligible = lineMode ? line >= from && line <= to : totalChars + part.length > offset;
        if (eligible) {
          const skip = lineMode ? 0 : Math.max(0, offset - totalChars);
          const value = part.slice(skip);
          selectedChars += value.length;
          if (start === null) start = totalChars + skip;
          if (content.length < limit) content += value.slice(0, limit - content.length);
        }
        totalChars += part.length;
        if (part.endsWith('\n')) line++;
      }
    }
    for await (const chunk of handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) {
      signal?.throwIfAborted();
      bytesRead += chunk.length;
      if (bytesRead > MAX_SCAN_BYTES) throw new Error('Text file grew beyond the scan budget.');
      hash.update(chunk);
      let text = pendingCR + decoder.decode(chunk, { stream: true });
      pendingCR = text.endsWith('\r') ? '\r' : '';
      if (pendingCR) text = text.slice(0, -1);
      consume(text);
    }
    consume(pendingCR + decoder.decode());
    const final = await handle.stat();
    if (initial.size !== bytesRead || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs)
      throw new Error('File changed during reading; retry against a stable version.');
    start ??= totalChars;
    const end = start + content.length;
    // A line request excludes the separator after its final line, matching the
    // existing readRange contract (coverage includes that separator).
    if (lineMode && selectedChars <= limit && content.endsWith('\n')) content = content.slice(0, -1);
    const overflow = selectedChars > limit;
    const hasMore = end < totalChars;
    return { content, sha256: hash.digest('hex'), readRange: { start, end },
      totalChars, totalLines: line, offset: start,
      ...(lineMode ? { startLine: from, endLine: from + content.split('\n').length - 1 } : {}),
      hasMore, truncated: overflow || hasMore,
      nextOffset: hasMore ? end : null,
      // A truncated long line MUST advance by offset, not repeat its line id.
      nextStartLine: lineMode && !overflow && hasMore ? Math.min(to + 1, line) : null,
      ...(overflow && lineMode ? { continuation: 'Use nextOffset without start_line/end_line to continue within this long line.' } : {}) };
  } finally { await handle.close(); }
}
