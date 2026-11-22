import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// Builds the admin SPA into dist/, which Wrangler serves as static assets.
// The Worker (src/worker) handles /api/* and /v1/* and is not bundled here.
export default defineConfig({
  root: '.',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/v1': 'http://127.0.0.1:8787' } },
})
