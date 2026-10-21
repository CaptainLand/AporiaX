import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Bounded-memory accounting for snapshots; never decode arbitrary files as text.
export async function hashFile(path, { signal, captureBytes = 0 } = {}) {
  const digest = createHash('sha256'); let bytes = 0;
  let chunks = captureBytes > 0 ? [] : null;
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.length; digest.update(chunk);
    if (chunks) { if (bytes <= captureBytes) chunks.push(chunk); else chunks = null; }
  }
  return { sha256: digest.digest('hex'), bytes, ...(chunks ? { content: Buffer.concat(chunks) } : {}) };
}
