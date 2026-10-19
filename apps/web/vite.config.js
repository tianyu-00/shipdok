import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// In development the browser talks to Vite only; /api is forwarded to the API, so the dashboard is "same origin" here
// exactly as it is in Docker (where nginx does the forwarding). Vite's default port, 5173, is the API's default WEB_ORIGIN.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
    css: false,
  },
})
