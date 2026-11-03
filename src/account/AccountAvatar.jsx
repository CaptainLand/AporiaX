import { AccountPortrait } from './AccountPortrait.jsx';
import { useAccount } from './AccountContext.jsx';

export function AccountAvatar({ compact = false, className = '' }) {
  const { avatarTemplate = 'main' } = useAccount();
  return <AccountPortrait template={avatarTemplate} className={`local-account-avatar${compact ? ' local-account-avatar--compact' : ''} ${className}`.trim()} />;
}
