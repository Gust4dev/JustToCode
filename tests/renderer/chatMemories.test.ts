import { describe, it, expect } from 'vitest'
import type { Instruction, StoredMessage } from '@shared/domain'
import {
  applyEngineEvent,
  hydrateChatState,
  hydrateMemories,
  initialChatState,
  memoryAnchorSeq
} from '../../src/renderer/src/features/chat/chatStore'

const mem = (id: string, p: Partial<Instruction> = {}): Instruction => ({
  id,
  kind: 'memory',
  scope: 'project',
  scopeId: 'p',
  name: id,
  description: '',
  trigger: 'always',
  globs: [],
  body: 'x',
  format: 'md',
  source: { type: 'app' },
  enabled: true,
  readonly: false,
  origin: { chatId: 'c', requestId: null, thirdParty: [] },
  createdAt: 100,
  updatedAt: 100,
  ...p
})

const msg = (seq: number, createdAt: number, requestId: string | null = null): StoredMessage => ({
  id: `m${seq}`,
  chatId: 'c',
  seq,
  message: { role: seq % 2 ? 'user' : 'assistant', content: 'oi' } as StoredMessage['message'],
  tokenEst: null,
  modelUsed: null,
  requestId,
  compacted: false,
  kind: 'normal' as StoredMessage['kind'],
  createdAt,
  attachments: []
})

const messages = [msg(1, 10), msg(2, 20, 'r1'), msg(3, 30), msg(4, 40, 'r2')]

describe('memoryAnchorSeq', () => {
  it('ancora pelo request que salvou; sem ele, pela ordem de criação', () => {
    expect(
      memoryAnchorSeq(
        messages,
        mem('a', { origin: { chatId: 'c', requestId: 'r1', thirdParty: [] } })
      )
    ).toBe(2)
    expect(memoryAnchorSeq(messages, mem('b', { createdAt: 35 }))).toBe(3)
    expect(memoryAnchorSeq(messages, mem('c', { createdAt: 5 }))).toBe(0)
    // requestId desconhecido cai no tempo.
    expect(
      memoryAnchorSeq(
        messages,
        mem('d', { createdAt: 25, origin: { chatId: 'c', requestId: 'zz', thirdParty: [] } })
      )
    ).toBe(2)
  })
})

describe('hydrateMemories', () => {
  const base = hydrateChatState(initialChatState(), messages, [])

  it('só memórias salvas a partir deste chat, ordenadas por criação, sem destaque', () => {
    const s = hydrateMemories(
      base,
      [
        mem('late', { createdAt: 35, updatedAt: 50 }),
        mem('early', { createdAt: 15, updatedAt: 15 }),
        mem('other', { origin: { chatId: 'x', requestId: null, thirdParty: [] } }),
        mem('noorigin', { origin: null }),
        { ...mem('rule'), kind: 'rule' }
      ],
      'c'
    )
    expect(s.memories.map((m) => m.instruction.id)).toEqual(['early', 'late'])
    expect(s.memories.map((m) => m.afterSeq)).toEqual([1, 3])
    expect(s.memories[0]).toMatchObject({ toolCallId: 'memory:early', created: true, at: 15 })
    expect(s.memories[1]).toMatchObject({ created: false, at: 50, undone: false })
  })

  it('não duplica o que já chegou por evento e é idempotente', () => {
    const live = applyEngineEvent(
      base,
      { type: 'memory_saved', chatId: 'c', instruction: mem('a'), toolCallId: 't1', created: true },
      'c',
      999
    )
    const s = hydrateMemories(live, [mem('a'), mem('b', { createdAt: 50 })], 'c')
    expect(s.memories.map((m) => m.toolCallId)).toEqual(['memory:b', 't1'])
    expect(hydrateMemories(s, [mem('a'), mem('b', { createdAt: 50 })], 'c')).toBe(s)
  })

  it('evento ao vivo de uma memória carregada substitui o card (dedupe por id)', () => {
    const s = hydrateMemories(base, [mem('a', { createdAt: 15 })], 'c')
    const next = applyEngineEvent(
      s,
      {
        type: 'memory_saved',
        chatId: 'c',
        instruction: mem('a', { body: 'novo', createdAt: 15 }),
        toolCallId: 't9',
        created: false
      },
      'c',
      500
    )
    expect(next.memories).toHaveLength(1)
    expect(next.memories[0]).toMatchObject({
      toolCallId: 't9',
      at: 500,
      afterSeq: 4,
      created: false
    })
    expect(next.memories[0].instruction.body).toBe('novo')
  })
})
