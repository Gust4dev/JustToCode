import { describe, it, expect } from 'vitest'

describe('ambiente de teste', () => {
  it('roda sob o Node do Electron', () => {
    expect(process.versions.electron).toBeTruthy()
  })
})
