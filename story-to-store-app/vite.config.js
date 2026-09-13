import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxies /plane-api/* → https://api.plane.so/api/v1/*
      // Bypasses browser CORS — request goes server→server via Vite
      '/plane-api': {
        target: 'https://api.plane.so',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/plane-api/, '/api/v1'),
      },
    },
  },
})
