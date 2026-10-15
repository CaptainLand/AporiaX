import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { Conversation } from '../../src/conversation/ConversationViews.jsx';
import '../../src/styles.css';

const user = id => ({id, role:'user', content:'做一个网页版的超级马里奥'});
const reply = {id:'reply',role:'assistant',status:'completed',content:'已交付；当前版本尚未完成运行验证。',steps:[]};
const cases = [
  ['files', [user('first'), {...reply,changes:[{path:'minecraft-lite.html',created:true,additions:605,deletions:0}]}, user('next')]],
  ['plain', [user('first'), reply, user('next')]],
  ['consecutive', [user('first'), user('next')]],
];
localStorage.setItem('aporiax.language.v1','zh-CN');
createRoot(document.getElementById('root')).render(<I18nProvider>
  <main style={{height:'100%',overflow:'auto'}}>
    {cases.map(([id,messages]) => <section id={id} key={id}><Conversation task={{id,messages}} isRunning={false} /></section>)}
  </main>
</I18nProvider>);
