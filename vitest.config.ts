import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // O runner Windows do GitHub Actions é bem mais lento que a máquina local:
    // testes de integração (git, PowerShell, fake router) passam de 5 s lá.
    testTimeout: process.env.CI ? 60_000 : 20_000,
    hookTimeout: process.env.CI ? 60_000 : 20_000
  }
})
