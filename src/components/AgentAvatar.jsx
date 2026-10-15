import React from 'react';
import main from '../assets/agent-avatars/aporiax-folded-wing.png';
import floating from '../assets/agent-avatars/aporiax-floating.png';
import explore from '../assets/agent-avatars/scout.png';
import review from '../assets/agent-avatars/sentry.png';
import verify from '../assets/agent-avatars/checko.png';
import builder from '../assets/agent-avatars/forge.png';
import curator from '../assets/agent-avatars/index.png';
import './agent-avatar.css';

// Approved local artwork. Custom roles inherit the portrait of their template;
// no identity, role configuration or runtime permissions are changed.
const portraits = { main, explore, review, verify, builder, curator };
export function AgentAvatar({ template = 'main', form = 'folded-wing', className = '' }) {
  const source = template === 'main' && form === 'floating' ? floating : portraits[template] || explore;
  return <span className={`agent-avatar ${className}`.trim()} data-avatar={template} aria-hidden="true">
    <img src={source} alt="" draggable={false} decoding="async" />
  </span>;
}
