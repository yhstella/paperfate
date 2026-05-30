import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    rollupOptions: {
      // Multiple HTML entry points so /embed.html ships alongside / for
      // the iframe-embeddable widget (Round 15 Worker IV).
      input: {
        main:  resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('/react/') || id.includes('\\react\\') || id.includes('scheduler')) {
              return 'vendor'
            }
          }
          if (id.includes('/src/lib/') || id.includes('\\src\\lib\\')) {
            return 'lib'
          }
        },
      },
    },
  },
})
