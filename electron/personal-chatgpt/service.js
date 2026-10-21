import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';

export const PERSONAL_CHATGPT_PROVIDER_ID = 'chatgpt-personal';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const random = () => randomBytes(32).toString('base64url');
const binding = record => createHash('sha256').update(JSON.stringify([record.clientId, record.subject])).digest('hex');
const fail = (code, message, status = 0) => Object.assign(new Error(message), { code, status, retryable: false });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// No configurable hosts, API keys, Cloud credentials, or backend-api endpoints.
// The only persisted secret is an OS-encrypted record owned by this installation.
export function createPersonalChatGPTService({ directory, safeStorage, openExternal,
  fetchImpl = globalThis.fetch, enabled = true, now = Date.now, loginTimeoutMs = 300_000, onChanged = () => {} } = {}) {
  let record = null, hostId = null, loaded = false, pending = null, refreshing = null;
  let epoch = 0, lastError = '', models = [], verifiedModels = new Set();
  let jwks = null, jwksAt = 0;
  let catalogLoading = null, catalogAttemptAt = -Infinity;
  const activeRequests = new Set();
  let chain = Promise.resolve();
  const notify = () => { try { Promise.resolve(onChanged()).catch(() => {}); } catch { /* UI refresh does not own authentication. */ } };
  const path = name => join(directory, name);
  const serial = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };
  const assertEnabled = () => { if (!enabled) throw fail('PERSONAL_CHATGPT_LOCAL_ONLY', '个人 ChatGPT 接入仅在本地开发版开放。'); };
  const assertSecure = () => {
    if (!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      throw fail('PERSONAL_CHATGPT_SECURE_STORAGE_REQUIRED', '系统安全凭据存储不可用，未保存登录信息。');
  };
  async function checkLeaf(file) {
    try { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile()) throw fail('PERSONAL_CHATGPT_STORAGE_INVALID', '个人账号存储路径异常。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function atomic(name, value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw fail('PERSONAL_CHATGPT_STORAGE_INVALID', '个人账号存储路径异常。');
    const target = path(name), temporary = path(`${name}.${randomUUID()}.tmp`);
    await checkLeaf(target);
    try { await writeFile(temporary, value, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  async function save() {
    assertSecure();
    const ciphertext = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
    await atomic('session.enc', JSON.stringify({ version: 1, ciphertext }));
  }
  async function load() {
    assertEnabled();
    if (loaded) return;
    await serial(async () => {
      if (loaded) return;
      try {
        await checkLeaf(path('session.enc'));
        const text = await readFile(path('session.enc'), 'utf8');
        if (text.length > 256_000) throw new Error('size');
        assertSecure();
        const envelope = JSON.parse(text);
        if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string') throw new Error('format');
        const value = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
        if (!value || typeof value.clientId !== 'string' || value.clientId === 'dynamic_agent_client' || typeof value.subject !== 'string') throw new Error('identity');
        record = value;
      } catch (error) {
        if (error.code !== 'ENOENT') throw fail('PERSONAL_CHATGPT_STORAGE_UNAVAILABLE', '无法安全读取个人 ChatGPT 登录信息，请检查系统凭据存储。');
      }
      loaded = true;
    });
  }
  async function getHostId() {
    if (hostId) return hostId;
    try {
      await checkLeaf(path('host.json'));
      const value = JSON.parse(await readFile(path('host.json'), 'utf8'));
      if (!/^urn:uuid:[0-9a-f-]{36}$/.test(value.hostId)) throw new Error('host');
      hostId = value.hostId;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('PERSONAL_CHATGPT_HOST_INVALID', '个人账号的本机标识异常。');
      hostId = `urn:uuid:${randomUUID()}`;
      await atomic('host.json', JSON.stringify({ hostId }));
    }
    return hostId;
  }
  async function request(url, init = {}) {
    const timeout = AbortSignal.timeout(20_000);
    return fetchImpl(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout });
  }
  async function postToken(form) {
    const response = await request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const expired = payload?.error === 'invalid_grant';
      throw fail(expired ? 'PERSONAL_CHATGPT_REAUTH_REQUIRED' : 'PERSONAL_CHATGPT_AUTH_FAILED', expired ? '个人 ChatGPT 授权已过期，请重新连接。' : 'OpenAI 授权未完成，请稍后重试。', response.status);
    }
    if (!payload || typeof payload.access_token !== 'string' || payload.access_token.length > 32_000 || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || String(payload.token_type).toLowerCase() !== 'bearer')
      throw fail('PERSONAL_CHATGPT_TOKEN_INVALID', 'OpenAI 返回的授权信息不完整。');
    return payload;
  }
  async function verifyIdentity(idToken, clientId, nonce) {
    if (typeof idToken !== 'string' || idToken.length > 64_000) throw fail('PERSONAL_CHATGPT_IDENTITY_INVALID', '无法验证 ChatGPT 账号身份。');
    const keys = async force => {
      if (!jwks || force || now() - jwksAt > 300_000) {
        const response = await request(`${ISSUER}/.well-known/jwks.json`);
        if (!response.ok) throw new Error('jwks');
        jwks = createLocalJWKSet(await response.json()); jwksAt = now();
      }
      return jwks;
    };
    try {
      let result;
      const options = { issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(now()) };
      try { result = await jwtVerify(idToken, await keys(false), options); }
      catch (error) { if (error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error; result = await jwtVerify(idToken, await keys(true), options); }
      const value = result.payload;
      if (!value.sub || (nonce !== undefined && !same(value.nonce, nonce)) || (value.azp && value.azp !== clientId)) throw new Error('claims');
      return value;
    } catch { throw fail('PERSONAL_CHATGPT_IDENTITY_INVALID', 'ChatGPT 身份校验失败，未使用或保存该授权。'); }
  }
  function snapshot() {
    return { available: enabled, status: pending ? 'authorizing' : record?.accessToken && !record.needsReauth ? 'connected' : 'disconnected',
      account: record ? { email: record.email || '', name: record.name || '' } : null,
      planUsageGranted: Boolean(record?.accessToken && !record.needsReauth && record.scopes?.includes(PLAN_SCOPE)),
      lastError, models: structuredClone(models), verifiedModelIds: [...verifiedModels], usageUrl: 'https://chatgpt.com/#settings/Usage' };
  }
  async function status() { if (!enabled) return snapshot(); await load(); return snapshot(); }
  function closeAttempt(attempt) {
    clearTimeout(attempt.timer); attempt.controller.abort();
    attempt.server.close(); attempt.server.closeAllConnections?.();
    if (pending === attempt) pending = null;
  }
  async function cancel() {
    epoch++;
    if (pending) closeAttempt(pending);
    return snapshot();
  }
  async function startLogin() {
    await load(); assertSecure();
    if (pending) return snapshot();
    const saved = record, generation = ++epoch;
    const attempt = { state: random(), nonce: random(), verifier: random(), generation, controller: new AbortController(), consumed: false };
    const reply = (res, statusCode, success) => {
      res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff' });
      res.end(`<!doctype html><meta charset="utf-8"><title>AporiaX</title><h2>${success ? '已连接 ChatGPT' : '未完成连接'}</h2><p>${success ? '请返回本地 AporiaX。可以关闭此页。' : '请返回 AporiaX 查看状态或重新连接。'}</p>`);
    };
    attempt.server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, attempt.redirectUri);
        if (req.method !== 'GET' || req.headers.host !== new URL(attempt.redirectUri).host || url.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return; }
        if (pending !== attempt || attempt.consumed || !same(url.searchParams.get('state'), attempt.state)) { reply(res, 400, false); return; }
        attempt.consumed = true;
        if (url.searchParams.has('error')) throw fail('PERSONAL_CHATGPT_CONSENT_DECLINED', '你取消了 ChatGPT 授权，账号未变更。');
        const code = url.searchParams.get('code');
        const clientId = url.searchParams.get('client_id') || saved?.clientId;
        if (!code || code.length > 16_000 || !clientId || clientId === 'dynamic_agent_client' || clientId.length > 512 || (saved && clientId !== saved.clientId))
          throw fail('PERSONAL_CHATGPT_REGISTRATION_INVALID', 'ChatGPT 注册回调不完整或与原账号不一致。');
        const token = await postToken({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: CHATGPT_RESOURCE });
        const claims = await verifyIdentity(token.id_token, clientId, attempt.nonce);
        if (saved && claims.sub !== saved.subject) throw fail('PERSONAL_CHATGPT_ACCOUNT_MISMATCH', '返回的 ChatGPT 账号与已绑定账号不一致。');
        const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
        if (!scopes.includes(PLAN_SCOPE)) throw fail('PERSONAL_CHATGPT_PLAN_PERMISSION_REQUIRED', '仅登录身份还不能使用套餐；请重新连接并允许使用 ChatGPT 套餐。');
        await serial(async () => {
          if (epoch !== generation || pending !== attempt) throw fail('PERSONAL_CHATGPT_LOGIN_CANCELED', '本次连接已取消。');
          const next = { clientId, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '', name: typeof claims.name === 'string' ? claims.name : '',
            idToken: token.id_token, nonce: attempt.nonce, accessToken: token.access_token, refreshToken: token.refresh_token || '', scopes, expiresAt: now() + token.expires_in * 1000 };
          const previous = record; record = next;
          try { await save(); } catch (error) { record = previous; throw error; }
          models = []; verifiedModels.clear(); lastError = '';
        });
        attempt.connected = true;
        reply(res, 200, true);
      } catch (error) {
        if (epoch === generation) lastError = error.code?.startsWith('PERSONAL_CHATGPT_') ? error.message : '连接 ChatGPT 失败，请检查网络后重试。';
        reply(res, 400, false);
      } finally {
        if (attempt.consumed) { clearTimeout(attempt.timer); attempt.server.close(); if (pending === attempt) pending = null; if (attempt.connected) notify(); }
      }
    });
    attempt.server.requestTimeout = 10_000;
    await new Promise((resolve, reject) => { attempt.server.once('error', reject); attempt.server.listen(0, '127.0.0.1', resolve); });
    attempt.redirectUri = `http://127.0.0.1:${attempt.server.address().port}/auth/callback`;
    pending = attempt; lastError = '';
    attempt.timer = setTimeout(() => { if (pending === attempt) { lastError = 'ChatGPT 授权超时，请重新连接。'; epoch++; closeAttempt(attempt); } }, loginTimeoutMs);
    attempt.timer.unref?.();
    try {
      const url = new URL(AUTHORIZE);
      const params = { client_id: saved?.clientId || 'dynamic_agent_client', ext_agent_host_id: await getHostId(),
        response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPES, resource: CHATGPT_RESOURCE,
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        ...(!saved ? { agent_name_hint: 'AporiaX' } : {}), ...(saved?.idToken ? { id_token_hint: saved.idToken } : {}), ...(saved?.email ? { login_hint: saved.email } : {}) };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      // The URL (which can contain an ID-token hint) never crosses renderer IPC.
      await openExternal(url.href);
      return snapshot();
    } catch { epoch++; closeAttempt(attempt); throw fail('PERSONAL_CHATGPT_BROWSER_FAILED', '无法打开官方授权页面，请检查默认浏览器后重试。'); }
  }
  async function access(expectedBinding) {
    await load();
    const selected = record;
    if (!selected?.accessToken || selected.needsReauth || !selected.scopes?.includes(PLAN_SCOPE)) throw fail('PERSONAL_CHATGPT_SIGN_IN_REQUIRED', '请先连接个人 ChatGPT 账号并允许使用套餐。', 401);
    if (expectedBinding && expectedBinding !== binding(selected)) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '个人 ChatGPT 账号已变化，请重新选择模型或开始新任务。', 401);
    if (selected.expiresAt > now() + 60_000) return selected.accessToken;
    if (!refreshing) {
      const generation = epoch;
      refreshing = serial(async () => {
        if (record !== selected || epoch !== generation) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '账号状态已变化，请重试。', 401);
        if (!selected.refreshToken) throw fail('PERSONAL_CHATGPT_REAUTH_REQUIRED', '请重新连接个人 ChatGPT 账号。', 401);
        const token = await postToken({ grant_type: 'refresh_token', client_id: selected.clientId, refresh_token: selected.refreshToken, resource: CHATGPT_RESOURCE });
        if (epoch !== generation) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '账号已断开。', 401);
        if (token.id_token) {
          const claims = await verifyIdentity(token.id_token, selected.clientId);
          if (claims.sub !== selected.subject || (claims.nonce && !same(claims.nonce, selected.nonce))) throw fail('PERSONAL_CHATGPT_ACCOUNT_MISMATCH', 'ChatGPT 刷新身份不一致。', 401);
        }
        if (epoch !== generation) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '账号状态已变化，请重试。', 401);
        const scopes = token.scope === undefined ? selected.scopes : String(token.scope).split(/\s+/).filter(Boolean);
        if (!scopes.includes(PLAN_SCOPE)) throw fail('PERSONAL_CHATGPT_PLAN_PERMISSION_REQUIRED', 'ChatGPT 套餐使用授权已取消，请重新连接。', 403);
        record = { ...selected, accessToken: token.access_token, refreshToken: token.refresh_token || selected.refreshToken, idToken: token.id_token || selected.idToken, scopes, expiresAt: now() + token.expires_in * 1000 };
        try { await save(); } catch (error) { record = selected; throw error; }
      }).catch(error => {
        if (epoch === generation) {
          lastError = error.code?.startsWith('PERSONAL_CHATGPT_') ? error.message : 'ChatGPT 授权刷新失败，请检查网络。';
          if (['PERSONAL_CHATGPT_REAUTH_REQUIRED', 'PERSONAL_CHATGPT_PLAN_PERMISSION_REQUIRED', 'PERSONAL_CHATGPT_ACCOUNT_MISMATCH'].includes(error.code) && record) { record.needsReauth = true; notify(); }
        }
        throw error;
      }).finally(() => { refreshing = null; });
    }
    await refreshing;
    if (!record?.accessToken || (expectedBinding && expectedBinding !== binding(record))) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '账号已断开。', 401);
    return record.accessToken;
  }
  async function authenticatedFetch(endpoint, init = {}, expectedBinding) {
    assertEnabled();
    if (!['/models', '/responses'].includes(endpoint)) throw fail('PERSONAL_CHATGPT_ENDPOINT_BLOCKED', '个人账号不支持此请求。');
    const generation = epoch;
    const token = await access(expectedBinding);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    for (const key of [...headers.keys()]) if (key.startsWith('x-aporia') || key === 'idempotency-key') headers.delete(key);
    if (generation !== epoch) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '账号状态已变化。', 401);
    // Inference has the runtime's abort/idle watchdog, not the login timeout.
    const controller = new AbortController();
    activeRequests.add(controller);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const response = await fetchImpl(`${CHATGPT_RESOURCE}${endpoint}`, { ...init, headers, signal, redirect: 'error' });
      if (response.body) {
        const reader = response.body.getReader();
        const cleanup = () => activeRequests.delete(controller);
        return new Response(new ReadableStream({
          async pull(sink) { try { const chunk = await reader.read(); if (chunk.done) { cleanup(); sink.close(); } else sink.enqueue(chunk.value); } catch (error) { cleanup(); sink.error(error); } },
          async cancel(reason) { cleanup(); await reader.cancel(reason); },
        }), { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      activeRequests.delete(controller); return response;
    } catch (error) { activeRequests.delete(controller); throw error; }
  }
  async function refreshModels() {
    const generation = epoch;
    const response = await authenticatedFetch('/models', { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw fail('PERSONAL_CHATGPT_MODELS_UNAVAILABLE', '无法读取个人 ChatGPT 模型，请检查套餐权限或重新连接。', response.status); }
    const payload = await response.json();
    if (generation !== epoch) throw fail('PERSONAL_CHATGPT_ACCOUNT_CHANGED', '账号已变化，请重新读取模型。');
    if (!Array.isArray(payload?.models)) throw fail('PERSONAL_CHATGPT_MODELS_INVALID', 'OpenAI 未返回账号模型列表。');
    models = payload.models.filter(m => m?.visibility === 'list' && typeof m.slug === 'string' && m.slug.length > 0 && m.slug.length < 200).slice(0, 100).map(m => {
      // Preserve server-advertised efforts only. Unknown capabilities are not
      // promoted into fictional five-position reasoning controls.
      const efforts = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map(value => typeof value === 'string' ? value : value?.effort).filter(value => EFFORTS.includes(value));
      return { id: m.slug, name: typeof m.display_name === 'string' ? m.display_name : m.slug, shortName: typeof m.display_name === 'string' ? m.display_name : m.slug,
        supportsTools: true, supportsImages: Array.isArray(m.input_modalities) && m.input_modalities.includes('image'),
        imageInput: Array.isArray(m.input_modalities) && m.input_modalities.includes('image') ? 'native' : 'text',
        supportsThinking: efforts.length > 0, thinkingMode: efforts.length ? 'personal-chatgpt' : 'none', supportedEfforts: [...new Set(efforts)],
        defaultEffort: efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : efforts.includes('high') ? 'high' : efforts[0] };
    });
    lastError = '';
    return snapshot();
  }
  async function provider() {
    let state;
    try { state = await status(); }
    catch { state = { status: 'unavailable' }; } // A damaged personal store must not disable Cloud/BYOK.
    if (state.status === 'connected' && !models.length && now() - catalogAttemptAt > 30_000) {
      if (!catalogLoading) {
        catalogAttemptAt = now();
        catalogLoading = refreshModels().catch(() => { lastError = '暂时无法读取个人 ChatGPT 模型，请在设置中刷新。'; }).finally(() => { catalogLoading = null; });
      }
      await catalogLoading;
      state = snapshot();
    } else if (catalogLoading) { await catalogLoading; state = snapshot(); }
    return { id: PERSONAL_CHATGPT_PROVIDER_ID, kind: 'chatgpt-personal', source: 'chatgpt-personal', name: '个人 ChatGPT', vendor: 'openai',
      protocol: 'responses', baseUrl: CHATGPT_RESOURCE, billing: 'personal-chatgpt-plan', managed: true, requiresAccount: true,
      disabled: state.status !== 'connected' || !state.planUsageGranted, models: structuredClone(models),
      disabledReasonZh: '请连接个人 ChatGPT 账号', disabledReasonEn: 'Connect your personal ChatGPT account', hasApiKey: false };
  }
  async function resolveProvider() {
    await access();
    const selectedBinding = binding(record), config = await provider();
    return { ...config, personalAccountBinding: selectedBinding,
      personalFetch: (endpoint, init) => authenticatedFetch(endpoint, init, selectedBinding),
      markPersonalModelVerified: modelId => { if (record && binding(record) === selectedBinding) verifiedModels.add(modelId); } };
  }
  async function signOut() {
    await load(); await cancel();
    // Stop new inference immediately, before awaiting remote revocation.
    if (record) record.needsReauth = true;
    models = []; verifiedModels.clear();
    notify();
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
    return serial(async () => {
      let revoked = !record?.refreshToken;
      if (record?.refreshToken) {
        try {
          const discovery = await request(`${ISSUER}/.well-known/openid-configuration`);
          const metadata = discovery.ok ? await discovery.json() : null;
          const endpoint = new URL(metadata?.revocation_endpoint);
          if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) throw new Error('endpoint');
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await request(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }) });
            await response.body?.cancel();
            if (response.status === 200) { revoked = true; break; }
            if (response.status < 500) break;
            if (!attempt) await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch { /* Local sign-out still clears tokens; disclose unconfirmed revocation. */ }
      }
      if (record) {
        record = { clientId: record.clientId, subject: record.subject, email: record.email, name: record.name };
        try { await save(); }
        catch (error) { await checkLeaf(path('session.enc')); await rm(path('session.enc'), { force: true }); throw error; }
      }
      models = []; verifiedModels.clear();
      lastError = revoked ? '' : '已在本机退出，但未确认远端撤销。可在 ChatGPT 设置中断开 AporiaX。';
      return snapshot();
    });
  }
  return { status, startLogin, cancel, signOut, refreshModels, provider, resolveProvider,
    dispose: () => { epoch++; if (pending) closeAttempt(pending); for (const controller of activeRequests) controller.abort(); activeRequests.clear(); } };
}
