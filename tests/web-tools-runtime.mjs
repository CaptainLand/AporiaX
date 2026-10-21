import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createWebRuntime, searchExa, fetchWebPage } from '../electron/runtime/web-runtime.js';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { defaultRole } from '../shared/professional-roles.js';
import { roleDefinition } from '../electron/runtime/role-capabilities.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-web-loop-'));
const originalFetch = globalThis.fetch;
const provider = { id: 'web-test', name: 'test', vendor: 'openai', baseUrl: 'https://model.invalid/v1', apiKey: 'model-test-only',
  models: [{ id: 'test', supportsTools: true, supportsThinking: false, contextWindow: 128000 }] };
const answer = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`);
const call = (id, name, args) => answer({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const toolsOf = body => new Set((body.tools || []).map(tool => tool.function.name));
const lastResult = body => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
const source = { title: 'AporiaX test docs', url: 'https://example.com/docs', text: 'Documented test facts.' };
const results = { structuredContent: { results: [source] } };

try {
  await writeFile(join(root, 'readme.txt'), 'unchanged workspace\n');
  for (const scenario of ['search-fetch', 'disabled', 'no-workspace', 'cancel']) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12000);
    const events = [];
    let modelCalls = 0, searches = 0, reads = 0;
    const webRuntimeFactory = () => createWebRuntime({
      search: async ({ query, objective }, { signal }) => {
        searches++;
        assert.equal(query, 'public documentation');
        assert(objective);
        if (scenario === 'cancel') {
          setTimeout(() => controller.abort(), 10);
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return results;
      },
      fetchPage: async url => {
        reads++;
        assert.equal(url, source.url);
        return { url, type: 'text/html', text: '<head><title>Test docs</title></head><main><h1>Facts</h1><p>Source text &amp; evidence.</p></main>' };
      },
    });
    globalThis.fetch = async (url, options) => {
      assert(String(url).startsWith(provider.baseUrl), `Unexpected external request: ${url}`);
      const body = JSON.parse(options.body), names = toolsOf(body);
      modelCalls++;
      assert.equal(names.has('web_search'), scenario !== 'disabled');
      assert.equal(names.has('web_fetch'), scenario !== 'disabled');
      if (scenario === 'search-fetch') assert(names.has('browser_open'), 'existing browser remains available');
      if (scenario === 'disabled') assert(!names.has('browser_open'));
      if (modelCalls === 1) return call('web-search', 'web_search', { query: 'public documentation' });
      const result = lastResult(body);
      if (scenario === 'disabled') {
        assert.match(result.error, /disabled by the extension policy/);
        return answer({ content: '联网已禁用，这次没有搜索。' });
      }
      if (modelCalls === 2) {
        assert.equal(result.results[0].url, source.url);
        assert.equal(result.evidence, 'search_excerpts');
        return call('web-read', 'web_fetch', { url: source.url });
      }
      assert.match(result.content, /Source text & evidence/);
      assert.equal(result.scriptsExecuted, false);
      return answer({ content: '查到了官方资料：[查看来源](https://example.com/docs)。' });
    };
    try {
      const pending = runHarness({ runId: `web-${scenario}`, taskId: 'web-test', provider, modelId: 'test',
        workspacePath: scenario === 'no-workspace' ? '' : root, permission: 'read-only', approvalMode: 'manual',
        messages: [{ role: 'user', content: '查一下这项功能的公开资料，只阅读，不修改文件。' }],
        signal: controller.signal, onEvent: event => events.push(event), webRuntimeFactory,
        extensionPolicy: scenario === 'disabled' ? { browser: false } : {},
        sandboxStatusResolver: async () => ({ available: false, localAvailable: false }),
        requestApproval: async () => assert.fail('read-only web tools do not request write/command approval') });
      const result = await pending;
      if (scenario === 'cancel') {
        assert.notEqual(result.status, 'completed');
        assert.equal(modelCalls, 1);
      } else {
        assert.equal(result.status, 'completed', result.content);
        assert.equal(result.changes?.length || 0, 0);
        assert.equal(searches, scenario === 'disabled' ? 0 : 1);
        assert.equal(reads, scenario === 'disabled' ? 0 : 1);
        assert(events.some(event => event.type === 'tool.started' && event.tool === 'web_search'));
        if (scenario !== 'disabled') assert(events.some(event => event.type === 'tool.completed' && event.tool === 'web_search' && event.success));
        assert(events.find(event => event.type === 'turn.started').tools.some(tool => tool.name === 'web_search') === (scenario !== 'disabled'));
      }
      console.log(`PASS actual Harness web loop: ${scenario}`);
    } catch (error) {
      if (scenario !== 'cancel' || error.name !== 'AbortError') throw error;
      console.log('PASS actual Harness web loop: cancel (AbortError)');
    } finally { clearTimeout(deadline); controller.abort(); }
  }

  for (const enabled of [true, false]) {
    let round = 0, executed = 0;
    const profile = { ...defaultRole('explore'), ...(enabled ? {} : { tools: ['read_file'] }) };
    const runtime = createWebRuntime({ search: async () => { executed++; return results; } });
    const worker = await runSubagentTask({
      agentId: `web-worker-${enabled}`, input: { role: 'explore', task: 'Find public documentation without reading unrelated workspace files.', scope: ['readme.txt'], background: false },
      provider: { supportsTools: true, supportsThinking: false, async complete({ body }) {
        assert.equal(toolsOf(body).has('web_search'), enabled);
        if (++round === 1) return { message: { content: null, tool_calls: [{ id: 'worker-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"public documentation"}' } }] } };
        const result = lastResult(body);
        if (enabled) assert.equal(result.results[0].url, source.url);
        else assert.match(result.error, /not enabled by Agent Registry/);
        return { message: { content: enabled ? 'Found a public source.' : 'This role is not allowed to search.' } };
      } },
      agentDefinition: roleDefinition(profile), modelId: 'test', modelConfig: { contextWindow: 128000 },
      workspaceRoot: root, parentPermissionPolicy: createPermissionPolicy('read-only'), approvalMode: 'manual',
      requestApproval: async () => assert.fail('unexpected approval'), signal: AbortSignal.timeout(5000),
      emit() {}, toolRegistry: TOOL_REGISTRY, parseToolArguments: call => JSON.parse(call.function.arguments),
      executeAuthorizedTool: async ({ toolName, input, signal }) => ({ modelResult: await runtime.execute(toolName, input, { signal }) }),
    });
    assert.equal(worker.status, 'completed');
    assert.equal(executed, enabled ? 1 : 0);
    if (enabled) assert.equal(worker.evidence[0].sources[0].url, source.url);
    runtime.clear();
    console.log(`PASS actual worker loop: ${enabled ? 'authorized narrow workspace scope' : 'explicit tool subset refuses unsolicited search'}`);
  }

  // Exercise the real MCP client/transport protocol, not only our injected
  // provider adapter. No live API/model calls and no persisted MCP config.
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(url).origin, 'https://mcp.exa.ai');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('x-api-key'), 'private-test-key');
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test-exa', version: '1' } }
      : body.params?.name === 'web_fetch_exa' ? { content: [{ type: 'text', text: '# Public document\nURL: https://example.com/docs\n\nExtracted public facts.' }] }
      : { content: [{ type: 'text', text: 'Title: Official\nURL: https://example.com/docs\nPublished: N/A\nAuthor: N/A\nHighlights:\nPublic facts.' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  const result = await searchExa({ query: 'public docs', objective: 'Find primary sources.', numResults: 3 }, { signal: AbortSignal.timeout(3000), apiKey: 'private-test-key' });
  assert.equal(result.isError, undefined);
  const searchRequest = requests.find(request => request.method === 'tools/call');
  assert.deepEqual(searchRequest.params.arguments, { query: 'public docs', objective: 'Find primary sources.', numResults: 3 });
  assert(!JSON.stringify(searchRequest).includes('private-test-key'));
  console.log('PASS real MCP transport handshake, current Exa arguments, credential isolation and clean close');
  const extracted = await fetchWebPage(source.url, { signal: AbortSignal.timeout(3000), apiKey: 'private-test-key',
    resolveHost: async () => [{ address: '198.18.0.4', family: 4 }], request: () => assert.fail('never connect to a fake/private IP') });
  assert.equal(extracted.provider, 'exa');
  assert.equal(extracted.evidence, 'provider_text');
  assert.equal(extracted.text, 'Extracted public facts.');
  const extractionCalls = requests.filter(request => request.params?.name === 'web_fetch_exa').length;
  assert.equal(extractionCalls, 1);
  await assert.rejects(fetchWebPage(source.url, { signal: AbortSignal.timeout(3000), apiKey: 'private-test-key',
    resolveHost: async () => [{ address: '10.0.0.1', family: 4 }], request: () => assert.fail('never connect to private IP') }), /WEB_URL_BLOCKED/);
  assert.equal(requests.filter(request => request.params?.name === 'web_fetch_exa').length, extractionCalls, 'private DNS must not activate remote extraction fallback');
  console.log('PASS proxy fake-IP extraction fallback is explicit; actual private DNS remains blocked');
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
