import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFileMenuTarget, fileMenuTemplate, executeFileMenuAction } from '../electron/workspace-file-menu.js';
import { appendFileMention } from '../src/composer/file-mention.js';
import { parseMentionTokens } from '../shared/mention-tokens.js';
const root = await mkdtemp(join(tmpdir(), 'aporia-file-menu-'));
try {
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', '中 文 & draft.txt'), 'fixture');
  await writeFile(join(root, 'check.cmd'), 'echo fixture');
  const target = await resolveFileMenuTarget(root, 'docs/中 文 & draft.txt');
  const calls = [];
  const deps = { shell: { openPath: async path => { calls.push(['open', path]); return ''; }, showItemInFolder: path => calls.push(['reveal', path]) }, clipboard: { writeText: value => calls.push(['copy', value]) }, confirmExecutable: async () => false };
  assert.equal(fileMenuTemplate(target).filter(item => item.id).length, 6);
  assert.equal(fileMenuTemplate(await resolveFileMenuTarget(root, 'docs'))[0].enabled, false);
  assert.equal(fileMenuTemplate(target, { canAddToChat: false })[0].enabled, false);
  for (const action of ['preview', 'add-to-chat', 'copy-path', 'copy-relative', 'open-default', 'reveal']) assert.equal((await executeFileMenuAction(target, action, deps)).path, target.relativePath);
  assert.deepEqual(calls, [['copy', target.path], ['copy', target.relativePath], ['open', target.path], ['reveal', target.path]]);
  await assert.rejects(resolveFileMenuTarget(root, '../outside.txt'), /escapes|outside|workspace/i);
  const executable = await resolveFileMenuTarget(root, 'check.cmd');
  assert.equal(await executeFileMenuAction(executable, 'open-default', deps), null);
  assert.equal(calls.length, 4, 'executable open requires explicit confirmation');
  await executeFileMenuAction(executable, 'open-default', { ...deps, confirmExecutable: async () => true });
  assert.equal(calls.at(-1)[1], executable.path);
  await assert.rejects(executeFileMenuAction(target, 'run-command', deps), /未知/);
  await assert.rejects(executeFileMenuAction(target, 'open-default', { ...deps, shell: { openPath: async () => 'No associated app' } }), /No associated/);
  for (const path of ['docs/中 文 & draft.txt', 'plain.ts', 'src/a}b.ts', 'browser:literal.txt', 'a@b.txt', 'a"b.txt']) {
    const text = appendFileMention('Existing draft', path);
    assert(text.startsWith('Existing draft\n'));
    assert.deepEqual(parseMentionTokens(text).map(item => item.value), [path]);
    assert.equal(appendFileMention(text, path), text, 'deduplicate existing file mention');
  }
  assert.throws(() => appendFileMention('keep', 'bad\nname'));
  assert.throws(() => appendFileMention('keep', 'bad}"name'));
  console.log('PASS native file menu: allowed actions, real workspace containment, copy/open/reveal, executable confirmation, whitespace/Chinese/special file mentions, draft preservation and deduplication.');
} finally { await rm(root, { recursive: true, force: true }); }
