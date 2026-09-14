const MAX_CHARS = 400000;
const isLow = (value) => value >= 0xdc00 && value <= 0xdfff;
const readers = new WeakMap();

export function wakeTerminalReaders(record) {
  for (const done of readers.get(record) || []) done();
}

// One bounded IPC read can sleep until ConPTY has data. This avoids both a
// keyboard echo poll delay and broadcasting every output packet through React.
export function waitForTerminalOutput(record, cursor, waitMs = 0) {
  const duration = Number(waitMs);
  const chunk = readTerminalOutput(record, cursor);
  if (!Number.isFinite(duration) || duration <= 0 || record.status !== "running" || chunk.output || chunk.cursorExpired) return Promise.resolve();
  let pending = readers.get(record);
  if (!pending) { pending = new Set(); readers.set(record, pending); }
  if (pending.size >= 4) return Promise.reject(new Error("Too many concurrent terminal reads."));
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); pending.delete(done); resolve(); };
    const timer = setTimeout(done, Math.min(1500, duration));
    pending.add(done);
  });
}

export function appendTerminalOutput(record, data) {
  record.output += data;
  if (record.output.length > MAX_CHARS) {
    let removed = record.output.length - MAX_CHARS;
    if (isLow(record.output.charCodeAt(removed))) removed++;
    record.offset += removed;
    record.output = record.output.slice(removed);
  }
  if (data) wakeTerminalReaders(record);
}

export function readTerminalOutput(record, requested = 0, limit = 80000) {
  const value = Number(requested), endCursor = record.offset + record.output.length;
  const cursor = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  let start = Math.min(record.output.length, Math.max(0, cursor - record.offset));
  if (isLow(record.output.charCodeAt(start))) start++;
  let end = Math.min(record.output.length, start + limit);
  if (end < record.output.length && isLow(record.output.charCodeAt(end))) end--;
  return { output: record.output.slice(start, end), cursor: record.offset + end, endCursor,
    hasMore: record.offset + end < endCursor, cursorExpired: cursor < record.offset || cursor > endCursor };
}
