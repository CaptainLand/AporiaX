import { publicWebUrl, fetchPublicPage, extractWebText, webError } from './web-fetch.js';
import { isWebToolName } from './web-tools.js';

const MAX_SEARCH_CHARS = 12_000;
const CACHE_TTL_MS = 180_000;
const abortError = () => Object.assign(new Error('联网工具调用已停止。'), { name: 'AbortError' });

async function withDeadline(operation, signal, timeoutMs) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const cancel = () => controller.abort(abortError());
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(webError('WEB_TIMEOUT', '联网请求超时，可改用浏览器或稍后重试。')), timeoutMs);
  let onAbort;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function callExaTool(tool, args, { signal, apiKey = process.env.EXA_API_KEY } = {}) {
  // The SDK is already shipped for the user's MCP ecosystem. Load on demand;
  // never register a hidden global MCP server or copy OpenCode into the app.
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  signal?.throwIfAborted();
  const client = new Client({ name: 'AporiaX-Web', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`https://mcp.exa.ai/mcp?tools=${tool}`), {
    requestInit: { headers: apiKey ? { 'x-api-key': apiKey } : {} },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (url, init = {}) => fetch(url, { ...init, redirect: 'error',
      signal: AbortSignal.any([signal, init.signal].filter(Boolean)) }),
  });
  const close = () => { void client.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    await client.connect(transport, { signal, timeout: 25_000 });
    return await client.callTool({ name: tool, arguments: args }, undefined,
      { signal, timeout: 25_000, resetTimeoutOnProgress: false });
  } finally {
    signal?.removeEventListener('abort', close);
    await client.close().catch(() => {});
  }
}

export const searchExa = ({ query, objective, numResults }, options) =>
  callExaTool('web_search_exa', { query, objective, numResults }, options);

export async function fetchExa(value, options) {
  const url = publicWebUrl(value).href;
  const response = await callExaTool('web_fetch_exa', { urls: [url], maxCharacters: 160000 }, options);
  if (response.isError) throw webError('WEB_FETCH_PROVIDER_ERROR', '网页提取服务返回错误，请使用浏览器或稍后重试。');
  const text = (response.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 170000);
  const header = text.match(/^# ([^\n]+)\r?\nURL: (https?:\/\/[^\s]+)\s*\n/);
  if (!header) throw webError('WEB_FETCH_INVALID_RESPONSE', '网页提取服务未返回可核对的来源，不作为读取成功。');
  const finalUrl = publicWebUrl(header[2]).href;
  const content = text.slice(header[0].length).trim();
  if (!content) throw webError('WEB_FETCH_EMPTY', '网页提取服务未返回正文，请使用浏览器。');
  return { url: finalUrl, type: 'text/markdown', text: content, title: header[1].trim().slice(0, 300),
    provider: 'exa', evidence: 'provider_text', extractionTruncated: content.length >= 160000,
    retrievalNotice: '代理虚拟 IP 环境：由 Exa 提取目标网页，可能使用缓存或省略部分内容；未做本地浏览器验证。' };
}

export async function fetchWebPage(url, options) {
  try { return await fetchPublicPage(url, options); }
  catch (error) {
    if (error.code !== 'WEB_FETCH_PROXY_DNS') throw error;
    return fetchExa(url, options);
  }
}

export function normalizeSearchResults(response, limit = 5) {
  const text = (response?.content || []).filter(item => item?.type === 'text').map(item => item.text).join('\n').slice(0, 240_000);
  if (response?.isError) {
    if (/rate.?limit|too many requests|quota|credits|429/i.test(text)) throw webError('WEB_SEARCH_RATE_LIMITED', '搜索服务额度或频率受限，可使用浏览器继续。');
    throw webError('WEB_SEARCH_PROVIDER_ERROR', '搜索服务返回错误，可换个关键词或使用浏览器。');
  }
  let structured = response?.structuredContent;
  if (!structured && text.trim().startsWith('{')) { try { structured = JSON.parse(text); } catch {} }
  let candidates = Array.isArray(structured?.results) ? structured.results : null;
  if (!candidates) {
    const pattern = /(?:^|\n\s*---\s*\n)\s*Title:\s*([^\n]*)\r?\nURL:\s*(https?:\/\/[^\s]+)[^\n]*\r?\n/g;
    const matches = [...text.matchAll(pattern)];
    candidates = matches.map((match, index) => {
      const body = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length);
      return { title: match[1], url: match[2], publishedDate: body.match(/^Published:\s*([^\n]+)/)?.[1],
        snippet: body.replace(/^Published:[^\n]*\n?/, '').replace(/^Author:[^\n]*\n?/, '').replace(/^(?:Highlights|Text|Content):\s*/, '') };
    });
    if (!candidates.length && !/^\s*(?:no (?:search )?results(?: found)?[.!]?|\[\])\s*$/i.test(text)) {
      throw webError('WEB_SEARCH_INVALID_RESPONSE', '搜索服务返回了无法识别的结果，未将其当作搜索成功。');
    }
  }
  const seen = new Set(), results = [];
  let remaining = MAX_SEARCH_CHARS;
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let url;
    try { url = publicWebUrl(item.url || item.href).href; } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const title = String(item.title || '').trim();
    const snippet = String(item.snippet ?? item.text ?? item.summary ?? item.highlights?.join('\n') ?? '').trim().slice(0, Math.min(1800, remaining));
    const date = String(item.publishedDate || item.publishedAt || '').trim();
    results.push({ title: !title || title === 'N/A' ? new URL(url).hostname : title.slice(0, 240), url, snippet,
      ...(/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(date) ? { publishedAt: date.slice(0, 40) } : {}) });
    remaining -= snippet.length;
    if (results.length >= limit || remaining <= 0) break;
  }
  if (candidates.length && !results.length) throw webError('WEB_SEARCH_INVALID_RESPONSE', '搜索结果没有可用的公开来源链接。');
  return results;
}

function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw webError('WEB_ARGUMENT_INVALID', `数值必须是 ${min}–${max} 的整数。`);
  return value;
}
function shortText(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw webError('WEB_ARGUMENT_INVALID', `${label}须为 1–1000 字符。`);
  return value.trim();
}

export function createWebRuntime({ search = searchExa, fetchPage = fetchWebPage, now = Date.now, timeoutMs = 25_000 } = {}) {
  // Per-run bounded cache: no shared profile/cookie/history storage.
  const cache = new Map();
  return {
    clear() { cache.clear(); },
    async execute(toolName, input = {}, { signal } = {}) {
      if (!isWebToolName(toolName)) throw webError('WEB_TOOL_UNKNOWN', '未知联网工具。');
      if (signal?.aborted) throw abortError();
      if (toolName === 'web_search') {
        const query = shortText(input.query, '搜索词');
        const objective = shortText(input.objective, '搜索目标', `Find relevant, current, preferably primary sources for: ${query}`.slice(0, 1000));
        const numResults = integer(input.num_results, 5, 1, 8);
        try {
          const response = await withDeadline(activeSignal => search({ query, objective, numResults }, { signal: activeSignal }), signal, timeoutMs);
          const results = normalizeSearchResults(response, numResults);
          return { provider: 'exa', query, results, resultCount: results.length, retrievedAt: new Date(now()).toISOString(),
            untrusted: true, evidence: 'search_excerpts', notice: '搜索摘要不代表已读取全文或完成浏览器验证。' };
        } catch (error) {
          if (error.name === 'AbortError' || error.code?.startsWith('WEB_')) throw error;
          if (error.code === 429 || /rate.?limit|too many requests|quota|429/i.test(error.message || '')) throw webError('WEB_SEARCH_RATE_LIMITED', '搜索服务额度或频率受限，可使用浏览器继续。');
          throw webError('WEB_SEARCH_UNAVAILABLE', '无法连接搜索服务，请检查网络或使用浏览器继续。');
        }
      }
      const url = publicWebUrl(input.url).href;
      const offset = integer(input.offset, 0, 0, 160000);
      const maxChars = integer(input.max_chars, 12000, 500, 24000);
      let document = cache.get(url);
      const cached = Boolean(document && now() - document.time < CACHE_TTL_MS);
      if (!cached) {
        try {
          const page = await withDeadline(activeSignal => fetchPage(url, { signal: activeSignal }), signal, timeoutMs);
          document = { ...extractWebText(page), url: page.url, time: now(), provider: page.provider || 'direct',
            evidence: page.evidence || 'http_text', retrievalNotice: page.retrievalNotice };
        } catch (error) {
          if (error.name === 'AbortError' || error.code?.startsWith('WEB_')) throw error;
          throw webError('WEB_FETCH_UNAVAILABLE', '网页读取失败，请检查网络或使用浏览器继续。');
        }
        if (!document.content) throw webError('WEB_FETCH_EMPTY', '未读取到可用正文；页面可能需要 JavaScript 或登录，请使用浏览器。');
        cache.delete(url);
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(url, document);
      }
      if (offset > document.content.length) throw webError('WEB_ARGUMENT_INVALID', '续读位置超出已提取的正文长度。');
      const content = document.content.slice(offset, offset + maxChars);
      const end = offset + content.length;
      return { url: document.url, title: document.title, content, offset, nextOffset: end < document.content.length ? end : null,
        totalChars: document.content.length, truncated: end < document.content.length || document.extractionTruncated,
        extractionTruncated: document.extractionTruncated, cached, fetchedAt: new Date(document.time).toISOString(),
        untrusted: true, provider: document.provider, evidence: document.evidence,
        ...(document.provider === 'direct' ? { scriptsExecuted: false } : {}),
        notice: document.retrievalNotice || '仅为网页文本，不含登录状态；不代表页面交互、视觉效果或实际运行已验证。' };
    },
  };
}
