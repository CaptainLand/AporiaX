import { parsePatch, applyPatch } from 'diff';

const failure = (message, code = 'PATCH_FORMAT_INVALID') => Object.assign(new Error(`${code}: ${message}`), { code, retryable: false });
const help = 'Use a unified diff (---/+++ headers), or *** Begin Patch / *** Delete File: path / *** End Patch. Prefer delete_file for deleting a file; never repeat its full contents.';

// One parser is shared by authorization, delegated scopes and execution.
// A format error must not turn into a fictitious filesystem permission error.
export function parseWorkspacePatch(patch) {
  if (typeof patch !== 'string' || !patch.trim() || patch.length > 500_000) throw failure(`Empty or oversized patch. ${help}`);
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  const operations = [];
  if (lines[0] === '*** Begin Patch') {
    if (lines.at(-1) !== '*** End Patch') throw failure(`Missing *** End Patch. ${help}`);
    let i = 1;
    while (i < lines.length - 1) {
      const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i++]);
      if (!header) throw failure(`Unsupported patch header. ${help}`);
      const [, kind, path] = header;
      const body = [];
      while (i < lines.length - 1 && !/^\*\*\* (?:Add|Delete|Update|Move)/.test(lines[i])) body.push(lines[i++]);
      if (lines[i]?.startsWith('*** Move')) throw failure('Move directives are not supported; do not silently rename files.', 'PATCH_FORMAT_UNSUPPORTED');
      if (kind === 'Delete') {
        if (body.length) throw failure('Delete File only accepts a path, not file content.');
        operations.push({ path, kind: 'delete', format: 'compact' });
      } else if (kind === 'Add') {
        if (body.some(line => !line.startsWith('+'))) throw failure('Every added file line must start with +.');
        operations.push({ path, kind: 'add', format: 'compact', content: body.map(line => line.slice(1)).join('\n') + (body.length ? '\n' : '') });
      } else {
        const hunks = [];
        for (const line of body) {
          if (hunks.at(-1)?.endOfFile) throw failure('End of File must be the final line of an Update File operation.');
          if (/^@@(?: |$)/.test(line)) hunks.push([]);
          else if (line === '*** End of File') {
            if (!hunks.length) throw failure('End of File requires a hunk.');
            hunks.at(-1).endOfFile = true;
          } else {
            if (!hunks.length || !/^[ +\-]/.test(line)) throw failure('Update File requires @@ hunks with context, + or - lines.');
            hunks.at(-1).push(line);
          }
        }
        if (!hunks.length || hunks.some(hunk => !hunk.length || !hunk.some(line => /^[+\-]/.test(line)))) throw failure('Update File contains no changes.');
        operations.push({ path, kind: 'update', format: 'compact', hunks });
      }
    }
  } else {
    let files;
    try { files = parsePatch(patch); } catch { throw failure(`Malformed unified diff. ${help}`); }
    for (const file of files) {
      if (!file.oldFileName || !file.newFileName || file.oldFileName === '/dev/null' && file.newFileName === '/dev/null') throw failure(`Missing file headers. ${help}`);
      const path = (file.newFileName === '/dev/null' ? file.oldFileName : file.newFileName).replace(/^[ab][\\/]/, '');
      if (!file.hunks?.length) throw failure(`Unified diff has no hunks. ${help}`);
      if (file.oldFileName !== '/dev/null' && file.newFileName !== '/dev/null' && file.oldFileName.replace(/^[ab][\\/]/, '') !== path) throw failure('Renames are not supported.', 'PATCH_FORMAT_UNSUPPORTED');
      operations.push({ path, kind: file.newFileName === '/dev/null' ? 'delete' : file.oldFileName === '/dev/null' ? 'add' : 'update', format: 'unified', file });
    }
  }
  if (!operations.length || operations.length > 50) throw failure(`A patch must contain 1–50 files. ${help}`);
  const paths = new Set();
  for (const op of operations) {
    const key = op.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!key.trim() || key.includes('\0') || paths.has(process.platform === 'win32' ? key.toLowerCase() : key)) throw failure('Empty or duplicate patch target.');
    paths.add(process.platform === 'win32' ? key.toLowerCase() : key);
  }
  return operations;
}

export function applyWorkspacePatch(previous, operation) {
  if (operation.format === 'unified') {
    const result = applyPatch(previous, operation.file);
    if (result === false) throw failure(`Context does not match ${operation.path}. Re-read the file before editing.`, 'PATCH_CONTEXT_MISMATCH');
    return result;
  }
  if (operation.kind === 'delete') return '';
  if (operation.kind === 'add') return operation.content;
  const eol = previous.includes('\r\n') ? '\r\n' : '\n';
  const trailing = previous.endsWith('\n');
  const lines = previous.replace(/\r\n/g, '\n').split('\n');
  if (trailing) lines.pop();
  let cursor = 0;
  for (const hunk of operation.hunks) {
    const before = hunk.filter(line => !line.startsWith('+')).map(line => line.slice(1));
    const after = hunk.filter(line => !line.startsWith('-')).map(line => line.slice(1));
    if (!before.length) throw failure('An insertion hunk needs existing context lines.');
    const matches = [];
    for (let i = cursor; i <= lines.length - before.length; i++) if ((!hunk.endOfFile || i + before.length === lines.length) && before.every((line, n) => lines[i + n] === line)) matches.push(i);
    if (matches.length !== 1) throw failure(`Context is missing or ambiguous in ${operation.path}. Add unique context or re-read the file.`, 'PATCH_CONTEXT_MISMATCH');
    lines.splice(matches[0], before.length, ...after); cursor = matches[0] + after.length;
  }
  return lines.join(eol) + (trailing && lines.length ? eol : '');
}
