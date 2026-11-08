import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sqliteVitePlugin, loadEnvConfig } from './server/sqlitePlugin.js'

const env = loadEnvConfig();

export default defineConfig({
  base: './',
  server: {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 5173,
  },
  preview: {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 5173,
  },
  plugins: [react(), tailwindcss(), sqliteVitePlugin()],
})
