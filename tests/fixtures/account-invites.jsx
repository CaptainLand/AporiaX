import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { AccountProvider } from '../../src/account/AccountContext.jsx';
import { LocalAccountPanel } from '../../src/account/LocalAccountPanel.jsx';
import '../../src/styles.css';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'light';
createRoot(document.getElementById('root')).render(<I18nProvider><AccountProvider>
  <aside style={{ position: 'fixed', bottom: 20, left: 10, width: 280, maxWidth: 'calc(100vw - 20px)' }}>
    <LocalAccountPanel onOpenAccountSettings={() => { window.fixture.opened++; }} />
  </aside>
</AccountProvider></I18nProvider>);
