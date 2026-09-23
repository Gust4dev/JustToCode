import { describe, it, expect } from 'vitest'
import type { ChangedFileSummary } from '@shared/domain'
import {
  commitErrorText,
  fileWarning,
  interpretRevert,
  joinNames
} from '../../src/renderer/src/features/diff/origins'
import { splitApprovalFlags } from '../../src/renderer/src/features/approvals/collision'

const file = (over: Partial<ChangedFileSummary>): ChangedFileSummary => ({
  path: 'a.ts',
  chatIds: [],
  origins: ['tool'],
  baseHash: null,
  currentHash: null,
  additions: 1,
  deletions: 0,
  binary: false,
  ...over
})

describe('fileWarning', () => {
  it('ambíguo lista os candidatos', () => {
    expect(fileWarning(file({ origins: ['ambiguous'], chatIds: ['x', 'y'] }), ['A', 'B'])).toBe(
      'mudança durante comandos de A e B'
    )
    expect(fileWarning(file({ origins: ['ambiguous'] }), [])).toBe(
      'mudança durante comandos de mais de um chat'
    )
  })

  it('vários chats sem ambiguidade; um chat sem aviso', () => {
    expect(fileWarning(file({ chatIds: ['x', 'y'] }), ['A', 'B'])).toBe(
      'Mais de um chat mexeu neste arquivo'
    )
    expect(fileWarning(file({ chatIds: ['x'] }), ['A'])).toBeNull()
  })

  it('joinNames', () => {
    expect(joinNames([])).toBe('')
    expect(joinNames(['A'])).toBe('A')
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B e C')
  })
})

describe('interpretRevert', () => {
  const conflict = { path: 'a.ts', base: 'b', current: 'c', reverted: 'r', merged: 'm' }
  it('reverted, conflito com conteúdo e conflito sem o objeto (binário/sem blob)', () => {
    expect(interpretRevert({ status: 'reverted' })).toEqual({ kind: 'reverted' })
    expect(interpretRevert({ status: 'conflict', conflict })).toEqual({
      kind: 'conflict',
      conflict,
      message: null
    })
    expect(interpretRevert({ status: 'conflict', message: 'binário' })).toEqual({
      kind: 'conflict-bare',
      message: 'binário'
    })
    expect(interpretRevert({ status: 'conflict' }).kind).toBe('conflict-bare')
  })
})

describe('commitErrorText', () => {
  it('traduz os códigos conhecidos e repassa o resto', () => {
    expect(commitErrorText('NOTHING_TO_COMMIT', 'x')).toMatch(/Nada para commitar/)
    expect(commitErrorText('NO_MODEL', 'x')).toMatch(/modelo/)
    expect(commitErrorText('EMPTY_RESPONSE', 'x')).toMatch(/não devolveu/)
    expect(commitErrorText('UNKNOWN_METHOD', 'x')).toMatch(/ainda não/)
    expect(commitErrorText(undefined, 'falhou')).toBe('falhou')
  })
})

describe('splitApprovalFlags', () => {
  it('separa colisões (sem repetir) dos outros flags', () => {
    expect(
      splitApprovalFlags([
        'destructive',
        'other_chat_touched:c1',
        'other_chat_touched:c1',
        'other_chat_touched:'
      ])
    ).toEqual({ collisions: ['c1'], others: ['destructive'] })
  })
})
