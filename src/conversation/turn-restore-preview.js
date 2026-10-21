import { diffLines } from 'diff';

// Project the inverse operation for preview only. Never mutate the captured
// change/Anchor: execution still uses the original snapshot and conflict guard.
export function turnRestorePreview(change) {
  const deleted = Boolean(change.beforeMissing ?? change.created);
  const created = Boolean(change.afterMissing ?? change.deleted);
  const beforeContent = created ? '' : String(change.afterContent ?? '');
  const afterContent = deleted ? '' : String(change.beforeContent ?? '');
  const rows = [];
  let beforeLine = 1, afterLine = 1, additions = 0, deletions = 0;
  if (!change.binary) for (const part of diffLines(beforeContent, afterContent)) {
    const lines = part.value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const content of lines) {
      const type = part.added ? 'added' : part.removed ? 'removed' : 'context';
      rows.push({ type, before: part.added ? '' : beforeLine++, after: part.removed ? '' : afterLine++, content });
      if (part.added) additions++;
      if (part.removed) deletions++;
    }
  }
  return { ...change, beforeContent, afterContent, created, deleted,
    beforeMissing: created, afterMissing: deleted, additions, deletions, rows };
}
