import { describe, it, expect } from 'vitest'
import { buildNotes } from '../../scripts/release-notes.mjs'

describe('buildNotes', () => {
  it('lista commits e filtra ruído', () => {
    expect(
      buildNotes([
        'feat: diff lado a lado',
        'chore(release): v0.0.1',
        'Merge branch x',
        'docs: ajuste [skip release]',
        'fix: medidor'
      ])
    ).toBe('- feat: diff lado a lado\n- fix: medidor')
  })

  it('vazio vira mensagem padrão', () => {
    expect(buildNotes([])).toBe('- Manutenção')
  })
})
