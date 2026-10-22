import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createOpenAICompatibleProvider } from '../electron/runtime/provider-stream.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-closure-loop-')), original = globalThis.fetch;
const provider = { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 128000 }] };
const response = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
const call = (name, args) => response({ tool_calls: [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
assert.equal(createOpenAICompatibleProvider({ config: provider, model: { id: 'fixture', imageInput: 'text', supportsImages: true, supportsImageProxy: true } }).supportsImages, false);
try {
  const workspace = join(root, 'workspace'); await mkdir(join(workspace, 'skill'), { recursive: true }); await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'skill/SKILL.md'), '---\nname: closure-loop\ndescription: Local test only\n---\nNo operations.');
  for (const scenario of ['approved', 'rejected', 'worker', 'wrong-owner', 'preflight']) {
    let count = 0, approvals = 0, transportError;
    const userDataDirectory = join(root, scenario);
    globalThis.fetch = async (_url, options) => {
      try {
        const body = JSON.parse(options.body), names = body.tools?.map(tool => tool.function.name) || [], last = body.messages.filter(message => message.role === 'tool').at(-1);
        if (body.messages.some(message => typeof message.content === 'string' && /You are the AporiaX verify subagent/.test(message.content))) throw Error('Invalid delegation must fail before starting worker.');
        if (scenario === 'preflight') {
          if (++count === 1) return call('delegate_subagent', { role: 'verify', task: 'Run synthetic checks', scope: ['src'] });
          assert.match(last.content, /DELEGATION_COMMAND_SCOPE_REQUIRED/);
          return call('finish_task', { status: 'partial', summary: '需要明确验证命令的权限范围。' });
        }
        if (['worker', 'wrong-owner'].includes(scenario)) { assert(!names.includes('install_workspace_skill')); return response({ content: 'No installation capability.' }); }
        assert(names.includes('install_workspace_skill'));
        if (++count === 1) return call('install_workspace_skill', { path: 'skill' });
        const receipt = JSON.parse(last.content); assert.equal(receipt.imported, scenario === 'approved');
        return response({ content: scenario === 'approved' ? '技能已安装。' : '未安装。' });
      } catch (error) { transportError = error; return response({ content: 'Fixture error.' }); }
    };
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const result = await runHarness({ runId: scenario, taskId: scenario, workspacePath: workspace, provider, modelId: 'fixture', signal: abort.signal,
        permission: 'workspace-write', approvalMode: 'full-auto', messages: [{ role: 'user', content: 'Install the local fixture Skill when confirmed; preflight scenario checks delegation only.' }],
        skillManagement: { ownerRunId: scenario === 'wrong-owner' ? 'different' : scenario, userDataDirectory },
        ...(scenario === 'worker' ? { acceptanceScope: 'worker' } : {}), requestApproval: async request => { approvals++; assert.equal(request.canRememberForRun, false); return { approved: scenario === 'approved' }; }, onEvent: () => {},
      });
      if (transportError) throw transportError;
      assert.equal(result.status, scenario === 'preflight' ? 'partial' : 'completed', result.content);
      assert.equal(approvals, ['approved', 'rejected'].includes(scenario) ? 1 : 0);
      if (scenario === 'approved') assert((await lstat(join(userDataDirectory, 'skills/closure-loop/SKILL.md'))).isFile());
      else await assert.rejects(lstat(join(userDataDirectory, 'skills')), { code: 'ENOENT' });
      console.log('PASS mocked Harness closure: ' + scenario);
    } finally { clearTimeout(timeout); abort.abort(); }
  }
} finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
