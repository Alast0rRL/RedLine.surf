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

const updateSW = registerSW({
  onNeedRefresh() {
    toast('Доступно обновление — нажмите, чтобы перезапустить', { duration: 0 });
    document.querySelector('.rl-toaster')?.addEventListener('click', () => void updateSW(true), { once: true });
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MatrixProvider>
      <App />
    </MatrixProvider>
  </StrictMode>,
);
