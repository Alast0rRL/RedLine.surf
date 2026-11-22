import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        // wasm криптографии ~5 МБ — тоже в precache, чтобы приложение открывалось офлайн
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // запасной декодер Ogg (старые Safari) с ML-модулем ~4 МБ — грузится по требованию
        globIgnores: ['**/opus-ml-*.js', '**/ogg-opus-decoder-*.js', '**/config.example.json'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
      manifest: {
        id: '/',
        name: 'Redline Chat',
        short_name: 'Redline',
        description: 'Семейный мессенджер Redline',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  optimizeDeps: {
    // wasm грузится через new URL(..., import.meta.url) — пре-бандлинг его ломает
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm', 'ogg-opus-decoder'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
