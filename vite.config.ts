import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH é definido pelo GitHub Actions como "/forjacad/". Local fica "/".
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['opencascade.js'] },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'ForjaCAD',
        short_name: 'ForjaCAD',
        description: 'CAD para ferramental: esboço com caneta, cotas, sólidos e desenho técnico.',
        lang: 'pt-BR',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#14171c',
        theme_color: '#14171c',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // O kernel OpenCASCADE (.wasm, ~50 MB) fica fora do pré-cache: se a cota de armazenamento do
        // aparelho não comportar, o app continua instalando. Ele entra no cache no primeiro uso, quando couber.
        runtimeCaching: [{
          urlPattern: /\.wasm$/,
          handler: 'CacheFirst',
          options: { cacheName: 'forjacad-kernel', cacheableResponse: { statuses: [0, 200] }, expiration: { maxEntries: 2 } },
        }],
      },
    }),
  ],
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 60000, hookTimeout: 60000 },
} as any);
