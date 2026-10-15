import React from 'react';
import { Search, ShieldCheck, CheckCheck, BookOpen, Wrench, Sparkles } from 'lucide-react';
import './role-robot.css';
import { AgentAvatar } from '../components/AgentAvatar.jsx';

// Keep the existing gallery sizing and role badges around the approved portraits.
const skins = {
  main: ['var(--accent-9)', Sparkles],
  explore: ['#84a98a', Search], review: ['#d9867a', ShieldCheck],
  verify: ['#c3ae69', CheckCheck], curator: ['#849fae', BookOpen], builder: ['#dd9964', Wrench],
};
export function RoleRobot({ template, className = '', badge = true }) {
  const [skin, Icon] = skins[template] || skins.explore;
  return <span className={`pr-robot ${className}`.trim()} style={{ '--robot-skin': skin }} aria-hidden="true">
    <AgentAvatar template={template} className="pr-portrait" />
    {badge && <span className="pr-robot-badge"><Icon size={12} /></span>}
  </span>;
}
