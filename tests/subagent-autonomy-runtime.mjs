import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runHarness } from '../electron/agent-runtime-core.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-handoff-'));
const original = globalThis.fetch;
const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
const call = (id, name, input) => sse({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
try {
  await mkdir(join(root, 'skills', 'fixture'), { recursive: true });
  await writeFile(join(root, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Handoff fixture\nauto: false\n---\nHANDOFF_SKILL_BODY');
  const workspace = join(root, 'project'); await mkdir(workspace);
  await writeFile(join(workspace, 'note.txt'), 'FIXTURE_NOTE');
  for (const scenario of ['handoff', 'denied', 'disabled']) {
    let main = 0, child = 0;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), text = body.messages.map(message => message.content || '').join('\n');
      if (text.includes('You are the AporiaX explore subagent.')) {
        child++;
        assert.match(text, /CONFIRMED_INTERFACE/);
        if (scenario === 'disabled') {
          assert(!body.tools.some(tool => tool.function.name === 'read_skill_resource'));
          if (child === 1) return call('disabled-skill', 'read_skill_resource', { skill: 'fixture', path: 'SKILL.md' });
          assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content, /not available|not enabled|denied/i);
          return sse({ content: 'Skills disabled; no workflow code executed.' });
        }
        assert(body.tools.some(tool => tool.function.name === 'read_skill_resource'));
        assert(!body.tools.some(tool => ['run_command', 'delegate_subagent', 'verify_project'].includes(tool.function.name)), 'parent read-only permission remains the ceiling');
        if (child === 1) return call('skill', 'read_skill_resource', { skill: 'fixture', path: 'SKILL.md' });
        assert.match(text, /HANDOFF_SKILL_BODY/);
        return sse({ content: 'Relevant workflow read; no code was executed.' });
      }
      main++;
      assert.match(text, /Delegate useful independent blocks early/);
      if (main === 1 && scenario !== 'denied') return call('parent-skill', 'read_skill_resource', { skill: 'fixture', path: 'SKILL.md' });
      if (main === (scenario === 'denied' ? 1 : 2)) return call('delegate', 'delegate_subagent', {
        role: 'explore', task: 'Read the relevant workflow', skills: ['fixture'], context: 'CONFIRMED_INTERFACE: read only; report uncertainty.', background: false,
      });
      if (scenario === 'disabled' && main === 3) {
        const last = body.messages.filter(message => message.role === 'tool').at(-1)?.content || '';
        assert.match(last, /Skills disabled/);
      }
      if (main === (scenario === 'denied' ? 2 : 3)) return call('accept', 'review_subagent_result', { agent_id: `${scenario}-sub-1`, report_id: `${scenario}-sub-1:1`, decision: 'accepted', reason: 'Workflow availability checked without granting execution permissions.', evidence_ids: [] });
      return sse({ content: 'Handoff inspection complete.' });
    };
    try {
      const result = await runHarness({ runId: scenario, taskId: 'fixture', workspacePath: workspace,
        userSkillsDirectory: join(root, 'skills'), extensionPolicy: { skill: scenario !== 'disabled' },
        roleSettings: defaultRoleSettings(), permission: 'read-only', approvalMode: 'manual', signal: controller.signal,
        provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'test', supportsTools: true, contextWindow: 128000 }] }, modelId: 'test',
        messages: [{ role: 'user', content: 'Inspect the workflow and current interface without changing files.' }] });
      assert.equal(result.status, 'completed', result.content);
      assert.equal(child, 2);
      assert.equal(result.subagents.length, 1);
      console.log(`PASS actual Main/worker mocked handoff: ${scenario}`);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  {
  const workspace = join(root, 'builder'); await mkdir(workspace);
  for (const args of [['init'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
    const git = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }); assert.equal(git.status, 0, git.stderr);
  }
  let main = 0, worker = 0;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body), text = body.messages.map(message => message.content || '').join('\n');
    if (text.includes('You are the AporiaX builder subagent.')) {
      worker++;
      const names = body.tools.map(tool => tool.function.name);
      assert(names.includes('verify_project')); assert(names.includes('run_command')); assert(!names.includes('delegate_subagent'));
      if (worker === 1) return call('bad-code', 'write_file', { path: 'module.mjs', content: 'export const = 1;' });
      if (worker === 2) return call('check-invalid', 'verify_project', { kind: 'node_check', path: 'module.mjs' });
      if (worker === 3) {
        const receipt = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        assert.equal(receipt.exitCode, 1); return call('read-current', 'read_file', { path: 'module.mjs' });
      }
      if (worker === 4) return call('fix-code', 'write_file', { path: 'module.mjs', content: 'export const fixed = 1;\n' });
      if (worker === 5) return call('check-valid', 'verify_project', { kind: 'node_check', path: 'module.mjs' });
      const receipt = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(receipt.exitCode, 0); assert.equal(receipt.parseOnly, true);
      return call('done', 'finish_subagent', { status: 'completed', summary: 'Implemented and fixed syntax; Node parse-only check passed. No runtime/browser test.' });
    }
    if (++main === 1) return call('delegate-builder', 'delegate_subagent', { role: 'builder', task: 'Implement module.mjs and check syntax.', write_scopes: ['module.mjs'] });
    if (main === 2) return call('accept-builder', 'review_subagent_result', { agent_id: 'builder-selfcheck-sub-1', report_id: 'builder-selfcheck-sub-1:1', decision: 'accepted', reason: 'Requested syntax check passed after the fix and changes were integrated; no runtime verification claimed.', evidence_ids: ['builder-selfcheck-sub-1:1:check-valid'] });
    return sse({ content: 'Module implemented; syntax checked, no runtime tests.' });
  };
  try {
    const result = await runHarness({ runId: 'builder-selfcheck', workspacePath: workspace, permission: 'workspace-write', approvalMode: 'manual', requestApproval: async () => ({ approved: true }), signal: controller.signal,
      roleSettings: defaultRoleSettings(), messages: [{ role: 'user', content: 'Implement module.mjs and verify syntax without executing project code.' }],
      provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'test', supportsTools: true, contextWindow: 128000 }] }, modelId: 'test' });
    assert.equal(result.status, 'completed', result.content); assert.equal(result.subagents[0].integrated, true);
    assert.equal(result.subagents[0].acceptance.status, 'accepted');
    assert(result.subagents[0].observedChecks.commands.some(command => command.exitCode === 0));
    console.log('PASS actual isolated Builder edit → failed syntax check → fix → successful check → conflict-checked integration → evidence review');
  } finally { clearTimeout(timer); controller.abort(); }
  }
} finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
