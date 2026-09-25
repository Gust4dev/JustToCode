import { describe, it, expect } from 'vitest'
import type { Chat, QueueState, QueuedMessage } from '../../src/shared/domain'
import { DEFAULT_CHAT_SETTINGS } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import {
  applyEngineEvent,
  hydrateQueue,
  initialChatState,
  type ChatViewState
} from '../../src/renderer/src/features/chat/chatStore'
import {
  budgetFraction,
  formatTokenInput,
  isContinuous,
  parseTokenInput,
  queueLabel,
  queuePaused,
  toggleContinuous
} from '../../src/renderer/src/features/chat/runControls'
import { applyChatUpdate } from '../../src/renderer/src/features/projects/chatUpdate'
import { withSwitchedWindow } from '../../src/renderer/src/features/context/format'

const C = 'chat-1'

const item = (id: string, text: string, position: number): QueuedMessage => ({
  id,
  chatId: C,
  text,
  attachments: [],
  position,
  createdAt: position
})

const queue = (
  items: QueuedMessage[],
  paused = false,
  pauseReason: string | null = null
): QueueState => ({ chatId: C, paused, pauseReason, items })

const run = (events: EngineEvent[], s: ChatViewState = initialChatState()): ChatViewState =>
  events.reduce((acc, e) => applyEngineEvent(acc, e, C), s)

describe('fila no reducer', () => {
  it('queue_changed do chat substitui a fila; de outro chat é ignorado', () => {
    const q = queue([item('q1', 'a', 1), item('q2', 'b', 2)])
    let s = run([{ type: 'queue_changed', queue: q }])
    expect(s.queue).toEqual(q)
    const other = { ...queue([item('x', 'x', 1)]), chatId: 'outro' }
    s = run([{ type: 'queue_changed', queue: other }], s)
    expect(s.queue).toEqual(q)
    s = run([{ type: 'queue_changed', queue: queue([item('q2', 'b', 2)]) }], s)
    expect(s.queue?.items.map((i) => i.id)).toEqual(['q2'])
  })

  it('fila pausada com motivo e retomada', () => {
    let s = run([
      { type: 'queue_changed', queue: queue([item('q1', 'a', 1)], true, 'erro no turno') }
    ])
    expect(queuePaused(s.queue)).toBe(true)
    expect(s.queue?.pauseReason).toBe('erro no turno')
    s = run([{ type: 'queue_changed', queue: queue([item('q1', 'a', 1)]) }], s)
    expect(queuePaused(s.queue)).toBe(false)
  })

  it('hydrateQueue não sobrescreve um queue_changed já recebido', () => {
    const live = queue([item('q2', 'b', 2)])
    const s = run([{ type: 'queue_changed', queue: live }])
    expect(hydrateQueue(s, queue([item('q1', 'a', 1)])).queue).toEqual(live)
    expect(hydrateQueue(initialChatState(), live).queue).toEqual(live)
  })

  it('queueLabel', () => {
    expect(queueLabel(null)).toBeNull()
    expect(queueLabel(queue([]))).toBeNull()
    expect(queueLabel(queue([item('q1', 'a', 1), item('q2', 'b', 2), item('q3', 'c', 3)]))).toBe(
      '3 na fila'
    )
  })
})

describe('orçamento e pausa no reducer', () => {
  it('budget_updated guarda o último valor do chat', () => {
    const s = run([
      {
        type: 'budget_updated',
        chatId: C,
        used: 1000,
        budget: 10000,
        iterations: 1,
        maxIterations: 50
      },
      {
        type: 'budget_updated',
        chatId: C,
        used: 4000,
        budget: 10000,
        iterations: 2,
        maxIterations: 50
      },
      {
        type: 'budget_updated',
        chatId: 'outro',
        used: 9,
        budget: 9,
        iterations: 9,
        maxIterations: 9
      }
    ])
    expect(s.budget).toEqual({ used: 4000, budget: 10000, iterations: 2, maxIterations: 50 })
    expect(budgetFraction(s.budget)).toBeCloseTo(0.4)
  })

  it('turn_paused marca o motivo e limpa o streaming; turn_started limpa a pausa', () => {
    let s = run([
      { type: 'turn_started', chatId: C, requestId: 'r1', model: 'combo' },
      { type: 'text_delta', chatId: C, requestId: 'r1', delta: 'oi' },
      { type: 'turn_paused', chatId: C, reason: 'budget' }
    ])
    expect(s.paused).toBe('budget')
    expect(s.streaming).toBeNull()
    expect(s.lastError).toBeNull()
    s = run([{ type: 'turn_started', chatId: C, requestId: 'r2', model: 'combo' }], s)
    expect(s.paused).toBeNull()
  })

  it('turn_paused por iterações; de outro chat é ignorado', () => {
    expect(run([{ type: 'turn_paused', chatId: C, reason: 'iterations' }]).paused).toBe(
      'iterations'
    )
    expect(run([{ type: 'turn_paused', chatId: 'outro', reason: 'iterations' }]).paused).toBeNull()
  })

  it('provider_switched guarda a janela nova (ou null)', () => {
    const s = run([
      { type: 'provider_switched', chatId: C, from: 'cc/sonnet', to: 'gpt-oss', window: 128000 },
      { type: 'provider_switched', chatId: C, from: 'gpt-oss', to: 'x' }
    ])
    expect(s.modelSwitches.map((m) => m.window)).toEqual([128000, null])
  })

  it('budgetFraction sem orçamento é null e satura em 1', () => {
    expect(budgetFraction(null)).toBeNull()
    expect(budgetFraction({ used: 5, budget: null, iterations: 1, maxIterations: null })).toBeNull()
    expect(budgetFraction({ used: 50, budget: 10, iterations: 1, maxIterations: null })).toBe(1)
  })
})

describe('campos do header', () => {
  it('parseTokenInput', () => {
    expect(parseTokenInput('')).toBeNull()
    expect(parseTokenInput('  ')).toBeNull()
    expect(parseTokenInput('12000')).toBe(12000)
    expect(parseTokenInput('200k')).toBe(200000)
    expect(parseTokenInput('1.5M')).toBe(1500000)
    expect(parseTokenInput('1,5m')).toBe(1500000)
    expect(parseTokenInput('200.000')).toBe(200000)
    expect(parseTokenInput('abc')).toBeUndefined()
    expect(parseTokenInput('0')).toBeUndefined()
    expect(parseTokenInput('-5')).toBeUndefined()
  })

  it('formatTokenInput ida e volta', () => {
    expect(formatTokenInput(null)).toBe('')
    expect(formatTokenInput(200000)).toBe('200k')
    expect(formatTokenInput(1500000)).toBe('1.5M')
    expect(formatTokenInput(12345)).toBe('12345')
    for (const n of [200000, 1500000, 12345]) expect(parseTokenInput(formatTokenInput(n))).toBe(n)
  })

  it('toggle Contínuo alterna entre null e o padrão', () => {
    expect(isContinuous(null)).toBe(true)
    expect(isContinuous(50)).toBe(false)
    expect(toggleContinuous(50, 50)).toBeNull()
    expect(toggleContinuous(null, 50)).toBe(50)
  })
})

const chat = (id: string, title: string, parentChatId: string | null = null): Chat => ({
  id,
  projectId: 'p1',
  parentChatId,
  agentName: null,
  title,
  color: '#000',
  combo: 'c',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  groupId: null,
  continuedFromChatId: null,
  maxIterations: 50,
  tokenBudget: null,
  settings: DEFAULT_CHAT_SETTINGS,
  lastReportedModel: null
})

describe('chat_updated', () => {
  it('troca o título de um chat de topo mantendo a ordem', () => {
    const top = { p1: [chat('a', 'Novo chat'), chat('b', 'B')] }
    const r = applyChatUpdate(top, {}, chat('a', 'Refatora o parser'))
    expect(r?.chats.p1.map((c) => c.title)).toEqual(['Refatora o parser', 'B'])
  })

  it('troca chat filho e ignora chat desconhecido', () => {
    const kids = { a: [chat('k', 'sub', 'a')] }
    const r = applyChatUpdate({ p1: [chat('a', 'A')] }, kids, chat('k', 'sub novo', 'a'))
    expect(r?.children.a[0].title).toBe('sub novo')
    expect(applyChatUpdate({ p1: [] }, {}, chat('z', 'Z'))).toBeNull()
  })
})

describe('withSwitchedWindow', () => {
  it('troca a janela e o modelo e mantém os tokens', () => {
    const ctx = {
      estTokens: 90000,
      reportedTokens: 100000,
      effectiveWindow: 1000000,
      limitingModel: 'sonnet'
    }
    expect(withSwitchedWindow(ctx, 128000, 'gpt-oss')).toEqual({
      estTokens: 90000,
      reportedTokens: 100000,
      effectiveWindow: 128000,
      limitingModel: 'gpt-oss'
    })
    expect(withSwitchedWindow(ctx, null, 'x')).toBe(ctx)
    expect(withSwitchedWindow(null, 128000, 'x')?.effectiveWindow).toBe(128000)
  })
})
