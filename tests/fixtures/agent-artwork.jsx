import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createOffice } from '../../src/office/office-scene.js';
import { AgentAvatar } from '../../src/components/AgentAvatar.jsx';
import { RoleRobot } from '../../src/settings/RoleRobot.jsx';
import { officePageRoster } from '../../src/office/office-model.js';
import '../../src/styles.css';
import '../../src/office/office.css';
const names = ['阿珀','探奇','察微','验准','搭匠','知序'];
const roles = ['main','explore','review','verify','builder','curator'];
const roster = officePageRoster(roles.map((role, index) => ({ id: index ? role : 'lead', role, name: names[index], color: '#84a98a', state: 'working', statusText: '工作中' })));
function Fixture() {
  const stage = useRef();
  useEffect(() => {
    const world = createOffice(stage.current, roster); window.artworkOffice = world;
    return () => { world.destroy(); delete window.artworkOffice; };
  }, []);
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
    <div className="agent-office" style={{ flex: 1, minHeight: 0, background: '#eeeae2' }}><div className="ao-scene ready" ref={stage} style={{ position: 'relative', width: '100%', height: '100%' }} /></div>
    <div style={{ display: 'flex', gap: 24, padding: 20, alignItems: 'center' }}>{roles.map((role, index) => <div key={role}><RoleRobot template={role} /><span>{names[index]}</span></div>)}<AgentAvatar template="main" form="floating" /></div>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
