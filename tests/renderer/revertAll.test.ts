import { describe, it, expect } from 'vitest'
import type { ChangedFileSummary } from '@shared/domain'
import { chatRevertTargets, revertAllSummary } from '../../src/renderer/src/features/diff/revertAll'

const file = (path: string, chatIds: string[]): ChangedFileSummary => ({
  path,
  chatIds,
  origins: ['tool'],
  baseHash: null,
  currentHash: null,
  additions: 1,
  deletions: 0,
  binary: false
})

describe('recusar tudo deste chat', () => {
  it('alvos são só os arquivos do chat', () => {
    expect(
      chatRevertTargets([file('a', ['x']), file('b', ['y']), file('c', ['y', 'x'])], 'x')
    ).toEqual(['a', 'c'])
  })

  it('resumo por resultado', () => {
    expect(revertAllSummary({ reverted: 2, conflicts: 0, failed: 0 })).toEqual({
      level: 'success',
      text: '2 arquivos revertidos'
    })
    expect(revertAllSummary({ reverted: 1, conflicts: 1, failed: 1 })).toEqual({
      level: 'warning',
      text: '1 arquivo revertido · 1 em conflito · 1 com erro'
    })
    expect(revertAllSummary({ reverted: 0, conflicts: 0, failed: 2 }).level).toBe('error')
  })
})
