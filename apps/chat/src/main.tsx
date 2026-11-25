import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/montserrat/latin-900.css';
import '@fontsource/montserrat/cyrillic-700.css';
import '@fontsource/montserrat/cyrillic-900.css';
import '@fontsource/open-sans/latin-400.css';
import '@fontsource/open-sans/latin-600.css';
import '@fontsource/open-sans/cyrillic-400.css';
import '@fontsource/open-sans/cyrillic-600.css';
import '@redline/ui/index.css';
import '@redline/ui/red-lines.js';
import './styles/app.css';
import { toast } from '@redline/ui';
import { MatrixProvider } from './state/MatrixContext';
import { App } from './App';
import { initTheme } from './lib/theme';

const updateSW = registerSW({
  onNeedRefresh() {
    // на экранах входа терять нечего — обновляемся сразу, иначе старая версия живёт до закрытия всех вкладок
    let signedIn = true;
    try {
      signedIn = !!(localStorage.getItem('rl.session') || localStorage.getItem('rl.session.mc'));
    } catch {
      /* хранилище недоступно — спросим */
    }
    if (!signedIn) return void updateSW(true);
    toast('Доступно обновление — нажмите, чтобы перезапустить', { duration: 0 });
    document.querySelector('.rl-toaster')?.addEventListener('click', () => void updateSW(true), { once: true });
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    // приложение на телефоне неделями живёт в фоне без перезагрузки — проверяем sw.js при каждом возврате
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (Date.now() - lastCheck < 10 * 60 * 1000) return;
      lastCheck = Date.now();
      void registration.update().catch(() => {});
    });
  },
});

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MatrixProvider>
      <App />
    </MatrixProvider>
  </StrictMode>,
);
