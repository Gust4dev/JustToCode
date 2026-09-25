import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings, type SecretCodec } from '../../src/main/settings'
import { DEFAULT_CONFIG } from '../../src/shared/domain'

const codec: SecretCodec = {
  available: true,
  encrypt: (s) => Buffer.from('x' + s).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString().slice(1)
}
const file = (): string => join(mkdtempSync(join(tmpdir(), 'jtc-set-')), 'settings.json')

describe('settings', () => {
  it('arquivo ausente devolve padrão', () => {
    expect(loadSettings(file(), codec)).toEqual(DEFAULT_CONFIG)
  })
  it('arquivo corrompido devolve padrão', () => {
    const f = file()
    writeFileSync(f, '{nope')
    expect(loadSettings(f, codec)).toEqual(DEFAULT_CONFIG)
  })
  it('salva chave criptografada e relê', () => {
    const f = file()
    saveSettings(f, codec, { routerApiKey: 'sk-1', defaultCombo: 'dev-combo' })
    expect(readFileSync(f, 'utf8')).not.toContain('sk-1')
    expect(loadSettings(f, codec)).toMatchObject({
      routerApiKey: 'sk-1',
      defaultCombo: 'dev-combo'
    })
  })
  it('sem safeStorage grava em claro', () => {
    const f = file()
    saveSettings(f, { ...codec, available: false }, { routerApiKey: 'sk-2' })
    expect(loadSettings(f, { ...codec, available: false }).routerApiKey).toBe('sk-2')
  })
  it('config antiga (F1) sem os campos da F2 recebe os padrões', () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ defaultCombo: 'dev', toolOutputMaxChars: 1000 }))
    const cfg = loadSettings(f, codec)
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, defaultCombo: 'dev', toolOutputMaxChars: 1000 })
    expect(cfg).toMatchObject({
      compactThresholdPct: 70,
      keepRecentMessages: 8,
      summarizerModel: '',
      summarizeToolOutputs: false,
      routerDbPath: '',
      unknownWindowFallback: 128_000
    })
  })
  it('config sem os campos da F3 recebe as raízes padrão, sem expandir ~', () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ defaultCombo: 'dev' }))
    expect(loadSettings(f, codec)).toMatchObject({
      instructionFiles: ['~/.claude/CLAUDE.md', '~/.codex/AGENTS.md'],
      skillRoots: ['~/.claude/skills', '~/.agents/skills'],
      commandRoots: ['~/.claude/commands'],
      agentRoots: ['~/.claude/agents'],
      pluginRoots: ['~/.claude/plugins/cache']
    })
  })
  it('listas inválidas caem no padrão; válidas são mantidas', () => {
    const f = file()
    writeFileSync(
      f,
      JSON.stringify({
        skillRoots: { a: 1 },
        commandRoots: [1, 2],
        agentRoots: ['C:/agents'],
        pluginRoots: 'x'
      })
    )
    const cfg = loadSettings(f, codec)
    expect(cfg.skillRoots).toEqual(DEFAULT_CONFIG.skillRoots)
    expect(cfg.commandRoots).toEqual(DEFAULT_CONFIG.commandRoots)
    expect(cfg.agentRoots).toEqual(['C:/agents'])
    expect(cfg.pluginRoots).toEqual(DEFAULT_CONFIG.pluginRoots)
  })
  it('ruleRoots: padrão ~/.claude/rules; lista inválida cai no padrão; válida é mantida', () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ defaultCombo: 'dev' }))
    expect(loadSettings(f, codec).ruleRoots).toEqual(['~/.claude/rules'])
    writeFileSync(f, JSON.stringify({ ruleRoots: [1] }))
    expect(loadSettings(f, codec).ruleRoots).toEqual(DEFAULT_CONFIG.ruleRoots)
    writeFileSync(f, JSON.stringify({ ruleRoots: ['C:/rules', '~/x'] }))
    expect(loadSettings(f, codec).ruleRoots).toEqual(['C:/rules', '~/x'])
  })
  it('reasoningStyle: padrão param, aceita valores válidos e ignora inválidos', () => {
    const f = file()
    expect(loadSettings(f, codec).reasoningStyle).toBe('param')
    expect(saveSettings(f, codec, { reasoningStyle: 'both' }).reasoningStyle).toBe('both')
    expect(loadSettings(f, codec).reasoningStyle).toBe('both')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(saveSettings(f, codec, { reasoningStyle: 'nope' as any }).reasoningStyle).toBe('both')
    writeFileSync(f, JSON.stringify({ reasoningStyle: 'xyz' }))
    expect(loadSettings(f, codec).reasoningStyle).toBe('param')
  })
})
