import { describe, it, expect } from 'vitest'
import { getConfig, setConfig, onConfig } from '../../src/agent-host/config'
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/domain'

describe('config do host', () => {
  it('setConfig notifica listeners e mantém os demais campos padrão', () => {
    const seen: AppConfig[] = []
    const off = onConfig((c) => seen.push(c))
    setConfig({ defaultCombo: 'a' })
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0].defaultCombo).toBe('a')
    expect(getConfig()).toEqual({ ...DEFAULT_CONFIG, defaultCombo: 'a' })
    setConfig({ lightCombo: 'b' })
    expect(seen).toHaveLength(1)
    expect(getConfig()).toMatchObject({ defaultCombo: 'a', lightCombo: 'b' })
  })
})
