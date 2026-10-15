import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppearanceStore } from '../electron/appearance/store.js';
import { PRESET_COLORS } from '../shared/appearance.js';
import { runHarness } from '../electron/agent-runtime-core.js';
const root = await mkdtemp(join(tmpdir(), 'aporia-theme-loop-'));
const originalFetch = globalThis.fetch;
const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
const call = (name, input) => sse({ tool_calls: [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const provider = { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://test.invalid/v1', apiKey: 'mock-only', models: [{ id: 'fixture', supportsTools: true, contextWindow: 128000 }] };
try {
  for (const scenario of ['main', 'worker', 'wrong-owner']) {
    const store = await createAppearanceStore(join(root, scenario));
    await store.change({ action: 'preferences', revision: 0, enabled: true });
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), names = body.tools?.map(tool => tool.function.name) || [];
      requests++;
      if (scenario !== 'main') { assert(!names.includes('create_aporiax_theme') && !names.includes('list_aporiax_themes')); return sse({ content: 'No appearance access.' }); }
      assert(names.includes('create_aporiax_theme') && names.includes('list_aporiax_themes'));
      if (requests === 1) return call('list_aporiax_themes', {});
      if (requests === 2) return call('create_aporiax_theme', { name: '松林', base: 'light', colors: { ...PRESET_COLORS.light, accent: '#16846a' } });
      return sse({ content: '主题候选已保存，请在设置中应用。' });
    };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await runHarness({ runId: scenario, taskId: 'theme', workspacePath: '', provider, modelId: 'fixture', permission: 'workspace-write', approvalMode: 'full-auto',
        messages: [{ role: 'user', content: '@skill:create-aporiax-theme 设计一个浅绿色 AporiaX 主题' }], signal: controller.signal,
        themeManagement: { ownerRunId: scenario === 'wrong-owner' ? 'different' : scenario, store },
        ...(scenario === 'worker' ? { acceptanceScope: 'worker' } : {}),
        requestApproval: async () => { throw Error('No extra approval for a candidate'); }, onEvent: () => {},
      });
      assert.equal(result.status, 'completed', result.content);
      assert.equal(store.snapshot().themes.length, scenario === 'main' ? 1 : 0);
      assert.equal(store.snapshot().selectedId, null);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  console.log('PASS mocked production Agent loop: Skill loads, main tool saves a candidate, worker/wrong-owner tools omitted, candidate never applied. No real model calls.');
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
