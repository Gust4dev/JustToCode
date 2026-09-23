import { describe, it, expect, beforeEach } from 'vitest'
import { useUi } from '../../src/renderer/src/stores/ui'

describe('useUi', () => {
  beforeEach(() => {
    useUi.setState({ projectId: null, chatId: null, view: 'chat' })
  })

  it('roda sem localStorage (ausente ou lançando)', () => {
    expect(() => useUi.getState().selectProject('p1')).not.toThrow()
    expect(useUi.getState().projectId).toBe('p1')
    const g = globalThis as { localStorage?: unknown }
    g.localStorage = {
      getItem: () => {
        throw new Error('bloqueado')
      },
      setItem: () => {
        throw new Error('bloqueado')
      }
    }
    try {
      expect(() => useUi.getState().selectChat('c1')).not.toThrow()
      expect(useUi.getState().chatId).toBe('c1')
    } finally {
      delete g.localStorage
    }
  })

  it('selectChat guarda o id', () => {
    useUi.getState().selectProject('p1')
    useUi.getState().selectChat('c1')
    expect(useUi.getState()).toMatchObject({ projectId: 'p1', chatId: 'c1' })
  })

  it('trocar de projeto limpa chatId', () => {
    useUi.getState().selectProject('p1')
    useUi.getState().selectChat('c1')
    useUi.getState().selectProject('p2')
    expect(useUi.getState()).toMatchObject({ projectId: 'p2', chatId: null })
  })

  it('persiste a seleção quando há localStorage', () => {
    const mem = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    g.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v)
    }
    try {
      useUi.getState().selectProject('p9')
      useUi.getState().selectChat('c9')
      expect(JSON.parse([...mem.values()][0])).toEqual({ projectId: 'p9', chatId: 'c9' })
    } finally {
      delete g.localStorage
    }
  })

  it('view: abrir Componentes e voltar ao escolher um chat; limpar seleção não mexe', () => {
    useUi.getState().selectProject('p1')
    useUi.getState().setView('components')
    expect(useUi.getState().view).toBe('components')
    useUi.getState().selectChat(null)
    expect(useUi.getState().view).toBe('components')
    useUi.getState().selectChat('c1')
    expect(useUi.getState().view).toBe('chat')
    useUi.getState().setView('components')
    useUi.getState().selectProject('p2')
    expect(useUi.getState().view).toBe('chat')
  })
})
