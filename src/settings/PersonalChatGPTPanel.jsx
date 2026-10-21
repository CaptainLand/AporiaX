import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';

export function PersonalChatGPTPanel({ onChanged }) {
  const { tr } = useI18n();
  const [state, setState] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const mounted = useRef(false), changed = useRef(onChanged), operation = useRef(0);
  const previousStatus = useRef(null);
  changed.current = onChanged;
  const api = window.desktop?.personalChatGPT;
  const safeError = () => tr('操作未完成，请检查网络和账号授权后重试。', 'Could not complete the action. Check your connection and account authorization.');
  useEffect(() => {
    mounted.current = true;
    let timer, polling = false;
    const read = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api.status();
        if (!mounted.current) return;
        const completed = previousStatus.current === 'authorizing' && next.status !== 'authorizing';
        previousStatus.current = next.status;
        setState(next);
        if (completed) {
          const updated = next.status === 'connected' ? await api.refreshModels() : next;
          if (mounted.current) setState(updated);
          await changed.current?.();
        }
      } catch { if (mounted.current) setError(safeError()); }
      finally { polling = false; }
    };
    if (api) { void read(); timer = setInterval(() => { if (previousStatus.current === 'authorizing' && document.visibilityState === 'visible') void read(); }, 1500); }
    return () => { mounted.current = false; operation.current++; clearInterval(timer); };
  }, [api]);
  async function act(action) {
    if (busy || !api) return;
    const id = ++operation.current;
    setBusy(action); setError('');
    try {
      const next = await api[action]();
      if (mounted.current && id === operation.current) { previousStatus.current = next.status; setState(next); }
      await changed.current?.();
    } catch (reason) {
      // Main-process errors contain app-owned descriptions only, not OAuth
      // responses, tokens, callback codes or authorization URLs.
      if (mounted.current && id === operation.current) setError(String(reason?.message || safeError()).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally { if (mounted.current && id === operation.current) setBusy(''); }
  }
  const connected = state?.status === 'connected', waiting = state?.status === 'authorizing';
  return <section className="provider-section personal-chatgpt-panel" aria-label={tr('个人 ChatGPT 账号', 'Personal ChatGPT account')}>
    <header><span className="personal-chatgpt-symbol"><ShieldCheck size={20} /></span><div>
      <h4>{tr('个人 ChatGPT', 'Personal ChatGPT')}</h4>
      <p>{tr('仅本机 · 个人套餐 · 不接公共池', 'Local only · Personal plan · No shared pool')}</p>
    </div><span className="personal-chatgpt-local">{tr('本地预览', 'Local preview')}</span></header>
    <p className="personal-chatgpt-description">{tr('通过 OpenAI 官方页面授权。对话与任务内容直接发送给 OpenAI，登录凭据由本机系统加密保存，不上传 Aporia Cloud。', 'Authorize on the official OpenAI page. Conversation and task content go directly to OpenAI; credentials are encrypted by this computer, never uploaded to Aporia Cloud.')}</p>
    {connected && <div className="personal-chatgpt-identity"><Check size={16} /><div><strong>{state.account?.email || state.account?.name || tr('已连接个人账号', 'Personal account connected')}</strong><small>{tr('使用账号授权的套餐额度；与其他应用共享限额，不会转用付费 API。', 'Uses your authorized plan and shared account limits. Never falls back to paid API billing.')}</small></div></div>}
    <div className="personal-chatgpt-actions">
      {!connected && !waiting && <button className="primary-button" type="button" disabled={Boolean(busy) || !state?.available} onClick={() => void act('startLogin')}>
        {busy === 'startLogin' && <LoaderCircle size={14} className="spin" />}Continue with ChatGPT</button>}
      {waiting && <><span role="status"><LoaderCircle size={14} className="spin" />{tr('请在浏览器完成授权…', 'Complete authorization in your browser…')}</span><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void act('cancel')}>{tr('取消连接', 'Cancel')}</button></>}
      {connected && <><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void act('refreshModels')}>{busy === 'refreshModels' && <LoaderCircle size={14} className="spin" />}{tr('刷新模型', 'Refresh models')}</button>
        <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">{tr('查看套餐用量', 'View plan usage')}<ExternalLink size={12} /></a>
        <button className="danger-text-button" type="button" disabled={Boolean(busy)} onClick={() => void act('signOut')}>{tr('断开账号', 'Disconnect')}</button></>}
    </div>
    {(error || state?.lastError) && <p className="api-key-error" role="alert">{error || state.lastError}</p>}
    {connected && <div className="personal-chatgpt-models"><h4>{tr('账号模型', 'Account models')}</h4>
      {!state.models.length && <p>{tr('暂未读取到可用模型，请刷新。是否可用以实际请求完成为准。', 'No models loaded yet. Refresh to retry. Access is confirmed only by a completed request.')}</p>}
      {state.models.map(model => <div key={model.id}><strong>{model.name}</strong><small>{state.verifiedModelIds?.includes(model.id) ? tr('已完成请求验证', 'Request verified') : tr('账号目录 · 待首次请求验证', 'Account catalog · Not yet verified')}</small></div>)}
    </div>}
    <p className="personal-chatgpt-footnote">{tr('需要账号支持并授予套餐使用权限。额度不足、授权过期或模型不可用时停止请求；不会改扣 Cloud，也不会影响 Codex 客户端的登录。', 'Requires an eligible account and plan-use consent. Requests stop on usage, authorization or model errors. No Cloud fallback; your Codex app login is unchanged.')}</p>
  </section>;
}
