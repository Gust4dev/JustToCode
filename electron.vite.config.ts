import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // Módulo nativo: nunca empacotar no bundle (dependencies já são externas por padrão).
        external: ['better-sqlite3'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'agent-host': resolve(__dirname, 'src/agent-host/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: shared }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        ...shared
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
