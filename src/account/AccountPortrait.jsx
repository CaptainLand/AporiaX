import { ACCOUNT_AGENT_AVATARS } from '../../shared/account-avatar.js';
import { AGENT_AVATAR_COLORS } from '../components/agent-avatar-colors.js';
import '../components/agent-avatar.css';
import './account-portrait.css';

const choiceFor = template => ACCOUNT_AGENT_AVATARS.includes(template) ? template : 'main';

export function accountPortraitLabel(template, language = 'zh-CN') {
  const names = {
    main: ['天蓝色', 'Sky blue'], explore: ['蓝色', 'Blue'], review: ['酒红色', 'Burgundy'],
    verify: ['黄色', 'Yellow'], builder: ['珊瑚红色', 'Coral'], curator: ['青绿色', 'Teal'],
  };
  return names[choiceFor(template)][String(language).startsWith('en') ? 1 : 0];
}

export function AccountPortrait({ template = 'main', className = '' }) {
  const choice = choiceFor(template);
  return <span className={`agent-avatar account-portrait ${className}`.trim()} data-avatar={choice} data-account-portrait="solid" style={{ '--account-portrait-color': AGENT_AVATAR_COLORS[choice] }} aria-hidden="true" />;
}
