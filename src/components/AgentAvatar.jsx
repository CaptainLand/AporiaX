import React from 'react';
import { AGENT_AVATAR_COLORS } from './agent-avatar-colors.js';
import './agent-avatar.css';

// Custom roles inherit the color of their template; role identities are unchanged.
export function AgentAvatar({ template = 'main', className = '' }) {
  const color = AGENT_AVATAR_COLORS[template] || AGENT_AVATAR_COLORS.explore;
  return <span className={`agent-avatar ${className}`.trim()} data-avatar={template} data-agent-portrait="solid" style={{ '--agent-avatar-color': color }} aria-hidden="true" />;
}
