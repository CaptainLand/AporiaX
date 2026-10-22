import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAppearanceStore } from '../electron/appearance/store.js';
import { PRESET_COLORS } from '../shared/appearance.js';
import { createAppearanceTools } from '../electron/runtime/appearance-tools.js';
import { createBrowserProfiles } from '../electron/workbench/browser-profiles.js';
import { createWorkspaceSkillInstaller } from '../electron/runtime/workspace-skill-install.js';
import { createBuilderWorkspaceManager } from '../electron/harness/builder-workspace.js';
import { normalizeSubagentInput, assertSubagentRealScope } from '../electron/runtime/subagent-model.js';
import { TaskAcceptance } from '../electron/runtime/task-acceptance.js';
import { evaluateNumericData } from '../electron/runtime/numeric-check.js';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { registerBrowserScreenshot, appendBrowserVisualEvidence, configureBrowserVisionProxy } from '../electron/runtime/browser-evidence.js';
import { checkWorkspaceFileLink } from '../electron/file-link-check.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-closure-'));
const test = async (name, fn) => { await fn(); console.log('PASS ' + name); };
const run = promisify(execFile);
try {
  await test('partial theme recovery preserves valid candidates and deletion history', async () => {
    const dir = join(root, 'appearance-case'), store = await createAppearanceStore(dir);
    await store.change({ action: 'preferences', revision: 0, enabled: true });
    await store.change({ action: 'save', revision: 1, theme: { name: 'Good', base: 'dark', colors: PRESET_COLORS.dark } });
    const stored = store.snapshot(), id = stored.themes[0].id;
    stored.themes.push({ id: 'bad', name: 'Damaged', colors: {} });
    await writeFile(join(dir, 'appearance/themes.json'), JSON.stringify(stored));
    const recovered = await createAppearanceStore(dir), snapshot = recovered.snapshot();
    assert.equal(snapshot.themes.length, 1); assert.equal(snapshot.themes[0].id, id);
    assert.ok(snapshot.recovery.backup); assert.equal(snapshot.recovery.issues.length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, 'appearance', snapshot.recovery.backup))).themes.length, 2);
    const list = await createAppearanceTools({ store: recovered })('list_aporiax_themes');
    assert.equal(list.capabilities.schemaVersion, 2); assert.equal(list.capabilities.legacyOverridesApplied, false);
    await recovered.change({ action: 'delete', revision: snapshot.revision, id });
    const restart = (await createAppearanceStore(dir)).snapshot();
    assert.ok(restart.history.some(item => item.action === 'deleted' && item.id === id));
    assert.ok(restart.history.some(item => item.action === 'recovered'));
    await writeFile(join(dir, 'appearance/themes.json'), '{broken');
    const broken = await createAppearanceStore(dir);
    await assert.rejects(broken.change({ action: 'preferences', revision: 0, enabled: true }), /保留/);
    assert.equal(await readFile(join(dir, 'appearance/themes.json'), 'utf8'), '{broken');
  });
  await test('browser persistence is opt-in, task/workspace scoped and restart-stable', async () => {
    const dir = join(root, 'profiles'), context = { taskId: 'one', workspacePath: root };
    const profiles = createBrowserProfiles(dir); await profiles.ready;
    assert.equal(profiles.partition(context), ''); await profiles.set(context, true);
    const selected = profiles.partition(context); assert.match(selected, /^persist:/);
    assert.equal(profiles.partition({ ...context, taskId: 'other' }), '');
    assert.equal(profiles.partition({ ...context, workspacePath: join(root, 'other') }), '');
    const restart = createBrowserProfiles(dir); await restart.ready; assert.equal(restart.partition(context), selected);
    await restart.set(context, false); assert.equal(restart.partition(context), '');
  });
  await test('Skill import requires fresh human approval and stable approved bytes', async () => {
    const workspace = join(root, 'skill-work'), source = join(workspace, 'skill'), userDataDirectory = join(root, 'skill-store');
    await mkdir(source, { recursive: true });
    const doc = '---\nname: closure-test\ntitle: Closure\ndescription: A local fixture\n---\nDo nothing.\n';
    await writeFile(join(source, 'SKILL.md'), doc);
    const make = requestApproval => createWorkspaceSkillInstaller({ workspaceRoot: workspace, userDataDirectory, requestApproval });
    assert.equal((await make(async () => ({ approved: false }))({ path: 'skill' })).imported, false);
    assert.equal((await make(async () => ({ approved: true, automatic: true }))({ path: 'skill' })).imported, false);
    await assert.rejects(lstat(userDataDirectory), { code: 'ENOENT' });
    await assert.rejects(make(async () => { await writeFile(join(source, 'new.txt'), 'changed'); return { approved: true }; })({ path: 'skill' }), /确认后发生变化/);
    const result = await make(async () => ({ approved: true }))({ path: 'skill' });
    assert.equal(result.imported, true); assert.equal(await readFile(join(result.path, 'SKILL.md'), 'utf8'), doc);
    await writeFile(join(source, 'SKILL.md'), doc + 'Next version.');
    const update = await make(async () => ({ approved: true }))({ path: 'skill' }); assert.ok(update.previousVersionPath);
    assert.equal(await readFile(join(update.previousVersionPath, 'SKILL.md'), 'utf8'), doc);
    await assert.rejects(make(async () => { throw Error('must not ask'); })({ path: '..' }), /outside|escape|workspace/i);
  });
  await test('unborn Git Builder isolates baseline and conflict-checks integration', async () => {
    const workspaceRoot = join(root, 'unborn'); await mkdir(workspaceRoot);
    const git = (...args) => run('git', args, { cwd: workspaceRoot, windowsHide: true });
    await git('init', '-q'); await writeFile(join(workspaceRoot, 'a.txt'), 'before'); await git('add', 'a.txt');
    const beforeIndex = await readFile(join(workspaceRoot, '.git/index'));
    const manager = createBuilderWorkspaceManager();
    for (const scenario of ['merge', 'conflict', 'scope']) {
      const worker = await manager.open({ workspaceRoot, agentId: `unborn-${scenario}`, writeScopes: ['a.txt'] });
      try {
        assert.equal(worker.isolationMode, 'private-snapshot');
        await writeFile(join(worker.workspaceRoot, 'a.txt'), 'worker-' + scenario);
        if (scenario === 'conflict') await writeFile(join(workspaceRoot, 'a.txt'), 'user');
        if (scenario === 'scope') await writeFile(join(worker.workspaceRoot, 'outside.txt'), 'escape');
        if (scenario === 'scope') await assert.rejects(worker.merge(), /outside its lease/);
        else assert.equal((await worker.merge()).merged, scenario === 'merge');
      } finally { await worker.close(); }
    }
    await assert.rejects(git('rev-parse', '--verify', 'HEAD'));
    assert.deepEqual(await readFile(join(workspaceRoot, '.git/index')), beforeIndex);
    assert.equal(await readFile(join(workspaceRoot, 'a.txt'), 'utf8'), 'user');
  });
  await test('command delegation is separate, explicit and never widens file reads', async () => {
    const workspace = join(root, 'scope'); await mkdir(join(workspace, 'src'), { recursive: true }); await writeFile(join(workspace, 'secret.txt'), 'x');
    const input = normalizeSubagentInput({ role: 'verify', task: 'test', scope: ['src'], command_scope: 'workspace' });
    assert.equal(input.commandScope, 'workspace');
    await assertSubagentRealScope('run_command', { cwd: '.' }, input.scope, workspace, input.commandScope);
    await assert.rejects(assertSubagentRealScope('read_file', { path: 'secret.txt' }, input.scope, workspace, input.commandScope), /outside/);
    await assert.rejects(assertSubagentRealScope('run_command', { cwd: '.' }, ['.'], workspace, 'none'), /not delegated/);
  });
  await test('numeric receipts replay exact input, reject false values and become stale on edits', async () => {
    const workspace = join(root, 'numeric'); await mkdir(workspace);
    const value = { rows: [{ ra: 2 }, { ra: 3 }], total: 5 };
    await writeFile(join(workspace, 'input.json'), JSON.stringify(value));
    const check = { type: 'json_numeric', path: 'input.json', operation: 'sum', rows: ['rows'], field: ['ra'], expectedKeys: ['total'] };
    const acceptance = new TaskAcceptance({ version: 1, requirements: [{ id: 'total', text: 'sum must match', checks: [check] }] }, { workspaceRoot: workspace });
    const before = await acceptance.evaluate(); assert.equal(before.passed, true);
    value.total = 6; await writeFile(join(workspace, 'input.json'), JSON.stringify(value));
    const after = await acceptance.evaluate(); assert.equal(after.passed, false);
    assert.notEqual(before.requirements[0].checks[0].sha256, after.requirements[0].checks[0].sha256);
    assert.equal(acceptance.decide('completed', after).action, 'continue');
    assert.throws(() => evaluateNumericData({ rows: [{ ra: '2' }], total: 2 }, check), /INVALID_VALUE/);
    assert.throws(() => evaluateNumericData({ rows: [{ ra: Infinity }], total: 2 }, check), /INVALID_VALUE/);
    assert.equal(evaluateNumericData(value, { operation: 'count', rows: ['rows'], expected: 2 }).passed, true);
    const executor = createNativeToolExecutor({ verifyExistingTarget: async (r, p) => resolve(r, p), verifyWritableTarget: async (r, p) => resolve(r, p), searchWorkspaceText: async () => ({}), calculateLineChanges: () => ({}), runGitCommand: async () => ({}) });
    const receipt = await executor({ toolName: 'verify_numeric_data', toolCall: {}, input: check, workspaceRoot: workspace });
    assert.equal(receipt.modelResult.passed, false); assert.equal(receipt.modelResult.actual, 5);
    await assert.rejects(executor({ toolName: 'verify_numeric_data', toolCall: {}, input: { ...check, path: '../outside.json' }, workspaceRoot: workspace }), /outside|escape/i);
  });
  await test('screenshot evidence uses native image or proxy, never an arbitrary returned path', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    const receipt = registerBrowserScreenshot(png, { url: 'https://fixture.invalid' });
    const messages = () => [{ role: 'assistant', tool_calls: [{ id: 'shot', function: { name: 'browser_screenshot' } }] }, { role: 'tool', tool_call_id: 'shot', content: JSON.stringify({ visualEvidence: receipt }) }];
    const native = messages(); await appendBrowserVisualEvidence(native, { supportsImages: true });
    assert.equal(native.at(-1).content[1].type, 'image_url');
    await appendBrowserVisualEvidence(native, { supportsImages: true }); assert.equal(native.length, 3);
    configureBrowserVisionProxy(async ({ dataUrl }) => { assert.match(dataUrl, /^data:image\/png/); return 'A square.'; });
    const proxy = messages(); await appendBrowserVisualEvidence(proxy, { supportsImages: false }); assert.match(proxy.at(-1).content, /A square/);
    configureBrowserVisionProxy(null);
    const unavailable = messages(); await appendBrowserVisualEvidence(unavailable, { supportsImages: false }); assert.match(unavailable.at(-1).content, /unavailable/);
    const fake = messages(); fake[0].tool_calls[0].function.name = 'read_file'; await appendBrowserVisualEvidence(fake, { supportsImages: true }); assert.equal(fake.length, 2);
  });
  await test('absolute workspace links normalize and missing links carry a readable error', async () => {
    const workspace = join(root, 'links'); await mkdir(workspace); await writeFile(join(workspace, 'a.txt'), 'a');
    assert.equal((await checkWorkspaceFileLink(workspace, join(workspace, 'a.txt'))).target, 'a.txt');
    assert.match((await checkWorkspaceFileLink(workspace, 'missing.txt')).message, /找不到|未找到/);
  });
} finally { configureBrowserVisionProxy(null); await rm(root, { recursive: true, force: true }); }
