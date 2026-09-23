import { describe, it, expect, beforeEach } from 'vitest'
import type { Approval } from '../../src/shared/domain'
import {
  approvalsReducer,
  pendingApprovals,
  useApprovals
} from '../../src/renderer/src/features/approvals/approvalsStore'

const mk = (id: string, over: Partial<Approval> = {}): Approval => ({
  id,
  chatId: 'c1',
  projectId: 'p1',
  toolCallId: `tc-${id}`,
  kind: 'command',
  summary: 'npm test',
  flags: [],
  status: 'pending',
  decidedAt: null,
  ...over
})

describe('approvalsReducer', () => {
  it('adiciona aprovações pedidas na ordem de chegada', () => {
    let s = approvalsReducer([], { type: 'requested', approval: mk('a') })
    s = approvalsReducer(s, { type: 'requested', approval: mk('b', { chatId: 'c2' }) })
    expect(s.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('ignora pedido duplicado (mesmo id) e devolve o mesmo estado', () => {
    const s = approvalsReducer([], { type: 'requested', approval: mk('a') })
    const again = approvalsReducer(s, { type: 'requested', approval: mk('a', { summary: 'x' }) })
    expect(again).toBe(s)
    expect(again).toHaveLength(1)
    expect(again[0].summary).toBe('npm test')
  })

  it('pedido repetido depois da decisão não reabre a aprovação', () => {
    let s = approvalsReducer([], { type: 'requested', approval: mk('a') })
    s = approvalsReducer(s, {
      type: 'resolved',
      approval: mk('a', { status: 'denied', decidedAt: 1 })
    })
    s = approvalsReducer(s, { type: 'requested', approval: mk('a') })
    expect(s[0].status).toBe('denied')
  })

  it('resolve no lugar, sem mudar a ordem', () => {
    let s = approvalsReducer([], { type: 'requested', approval: mk('a') })
    s = approvalsReducer(s, { type: 'requested', approval: mk('b') })
    s = approvalsReducer(s, {
      type: 'resolved',
      approval: mk('a', { status: 'allowed', decidedAt: 10 })
    })
    expect(s.map((a) => [a.id, a.status])).toEqual([
      ['a', 'allowed'],
      ['b', 'pending']
    ])
    expect(pendingApprovals(s).map((a) => a.id)).toEqual(['b'])
  })

  it('resolução de aprovação desconhecida é acrescentada', () => {
    const s = approvalsReducer([], {
      type: 'resolved',
      approval: mk('z', { status: 'allowed', decidedAt: 1 })
    })
    expect(s).toHaveLength(1)
    expect(pendingApprovals(s)).toHaveLength(0)
  })

  it('snapshot substitui a lista, mas não reabre decisão já conhecida', () => {
    let s = approvalsReducer([], { type: 'requested', approval: mk('old') })
    s = approvalsReducer(s, {
      type: 'resolved',
      approval: mk('a', { status: 'allowed', decidedAt: 5 })
    })
    s = approvalsReducer(s, { type: 'loaded', approvals: [mk('a'), mk('b')] })
    expect(s.map((a) => [a.id, a.status])).toEqual([
      ['a', 'allowed'],
      ['b', 'pending']
    ])
  })

  it('removed tira a aprovação; id desconhecido não muda o estado', () => {
    const s = approvalsReducer([], { type: 'requested', approval: mk('a') })
    expect(approvalsReducer(s, { type: 'removed', id: 'x' })).toBe(s)
    expect(approvalsReducer(s, { type: 'removed', id: 'a' })).toEqual([])
  })
})

describe('useApprovals', () => {
  beforeEach(() => {
    useApprovals.setState({ approvals: [], deciding: {} })
  })

  it('dispatch aplica o reducer e marca/desmarca decisões em andamento', () => {
    const { dispatch, setDeciding } = useApprovals.getState()
    dispatch({ type: 'requested', approval: mk('a') })
    dispatch({ type: 'requested', approval: mk('a') })
    expect(useApprovals.getState().approvals).toHaveLength(1)
    setDeciding('a', true)
    expect(useApprovals.getState().deciding).toEqual({ a: true })
    setDeciding('a', false)
    expect(useApprovals.getState().deciding).toEqual({})
  })
})
