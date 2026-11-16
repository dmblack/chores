import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  resolve: { alias: { '@shared': here('../shared') } },
  // One ~210 KB (gzipped) bundle, cached on the iPad by the service worker.
  build: { outDir: here('dist'), emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: {
    host: true,
    port: 5173,
    fs: { allow: [here('..')] },
    proxy: { '/api': { target: 'http://localhost:3000' }, '/watch': { target: 'http://localhost:3000' } },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Chores',
        short_name: 'Chores',
        description: 'Household chores: mark it done, someone else approves.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#fafafa',
        theme_color: '#0f6cbd',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/watch/], // /watch is the server-rendered Apple Watch page
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
