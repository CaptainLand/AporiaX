import React from 'react';
import { AgentAvatar } from './AgentAvatar.jsx';
import './agent-avatar.css';

export function AgentTeamAvatar({ className = '' }) {
  return <span className={`agent-team-avatar ${className}`.trim()} aria-hidden="true">
    {['main','explore','review','verify','builder','curator'].map(template => <AgentAvatar key={template} template={template} />)}
  </span>;
}
