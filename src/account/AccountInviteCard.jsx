import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n';

export function AccountInviteCard({ invites }) {
  const { tr } = useI18n();
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(''), 2500);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const code = invites?.inviteCode;
  const exhausted = invites?.rewardsExhausted === true;
  const count = invites?.successfulInvites;
  const reward = invites?.nextRewardPercent;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };
  return <section className="local-account-invite-card" aria-label={tr('邀请好友', 'Invite friends')}>
    <div className="local-account-invite-heading">
      <span>{tr('个人邀请码', 'Your invite code')}</span>
      {code && <button type="button" onClick={copy} aria-label={tr('复制邀请码', 'Copy invite code')}>
        {copyStatus === 'copied' ? <Check size={12} /> : <Copy size={12} />}
        <span aria-live="polite">{copyStatus === 'copied' ? tr('已复制', 'Copied') : tr('复制', 'Copy')}</span>
      </button>}
    </div>
    {code ? <>
      <code className="local-account-invite-code">{code}</code>
      <div className="local-account-invite-reward">
        <span>{exhausted ? tr('当前阶段', 'Current stage') : Number.isSafeInteger(count) && count >= 0
          ? tr(`第 ${count + 1} 次有效邀请`, `Qualified invite #${count + 1}`)
          : tr('下次有效邀请', 'Next qualified invite')}</span>
        <strong>{exhausted ? tr('奖励已领完', 'Rewards completed') : Number.isFinite(reward) && reward > 0
          ? tr(`回补 ${reward}%`, `${reward}% refill`)
          : tr('奖励待更新', 'Reward unavailable')}</strong>
      </div>
      <p className="local-account-invite-note">{exhausted
        ? tr('仍可分享邀请码，暂无额外额度奖励。', 'You can still share your code; no further quota rewards.')
        : tr('仅补回本周已用额度，最高恢复至 100%。', 'Refills used weekly quota only, up to 100%.')}</p>
      {copyStatus === 'failed' && <p className="local-account-invite-error" role="alert">{tr('复制失败，请选中邀请码手动复制。', 'Could not copy. Select the code to copy it manually.')}</p>}
    </> : <p className="local-account-invite-note" role="status">{tr('邀请信息暂不可用，可点击下方刷新重试。', 'Invite info unavailable. Use Refresh below to try again.')}</p>}
  </section>;
}
