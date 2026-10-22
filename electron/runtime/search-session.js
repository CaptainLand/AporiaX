export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

export function searchProgressDetail(progress, language = 'zh-CN') {
  const english = String(language).startsWith('en');
  const seconds = Math.floor((progress.elapsedMs || 0) / 1000);
  if (progress.phase === 'index') return english
    ? `Indexing file names · ${progress.indexedFiles || 0} files · ${seconds}s`
    : `正在整理文件列表 · 已找到 ${progress.indexedFiles || 0} 个文件 · ${seconds} 秒`;
  const count = Number.isFinite(progress.filesScanned)
    ? (english ? `Checked ${progress.filesScanned} files · ` : `已检查 ${progress.filesScanned} 个文件 · `) : '';
  return english ? `${count}${progress.matches || 0} matches · ${seconds}s`
    : `${count}找到 ${progress.matches || 0} 处匹配 · ${seconds} 秒`;
}

export function searchAbortError() {
  return Object.assign(new Error('The search was interrupted.'), { name: 'AbortError' });
}

// One deadline covers enumeration, native search and any portable fallback.
export async function withSearchSession({ signal, timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS, onProgress } = {}, operation) {
  const controller = new AbortController();
  const started = Date.now();
  const budget = Math.max(1, Math.min(60_000, Number(timeoutMs) || DEFAULT_SEARCH_TIMEOUT_MS));
  const abort = () => controller.abort(searchAbortError());
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  let state = {}, lastProgress = 0, rejectAbort;
  const report = (value = {}, force = false) => {
    state = { ...state, ...value };
    if (controller.signal.aborted || (!force && Date.now() - lastProgress < 500)) return;
    lastProgress = Date.now();
    try { onProgress?.({ ...state, elapsedMs: Date.now() - started }); } catch { /* UI observers cannot interrupt a search. */ }
  };
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const reject = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', reject, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => controller.abort(Object.assign(
    new Error(`搜索超过 ${Math.ceil(budget / 1000)} 秒，请缩小目录或增加文件筛选后重试。`),
    { code: 'SEARCH_TIMEOUT', name: 'SearchTimeoutError', retryable: true },
  )), budget);
  const heartbeat = setInterval(() => report({}, true), 1000);
  heartbeat.unref?.();
  if (signal?.aborted) abort();
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      check();
      return operation({ signal: controller.signal, check, report });
    })]);
  } finally {
    clearTimeout(deadline); clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', reject);
  }
}
