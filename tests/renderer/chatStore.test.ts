import { describe, it, expect } from 'vitest'
import type {
  Approval,
  CompactionRecord,
  StoredMessage,
  ToolCallRecord
} from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import {
  applyApprovalEvent,
  applyEngineEvent,
  buildTimeline,
  compactedCount,
  hydrateCompactions,
  hydrateChatState,
  initialChatState,
  type ChatViewState
} from '../../src/renderer/src/features/chat/chatStore'

const C = 'chat-1'

const msg = (id: string, seq: number, role: 'user' | 'assistant', text: string): StoredMessage => ({
  id,
  chatId: C,
  seq,
  message: role === 'user' ? { role, content: text } : { role, content: text },
  tokenEst: null,
  modelUsed: null,
  requestId: role === 'assistant' ? 'r1' : null,
  compacted: false,
  kind: 'message',
  createdAt: 1,
  attachments: []
})

const tc = (status: ToolCallRecord['status'], preview: string | null = null): ToolCallRecord => ({
  id: 'tc1',
  modelCallId: 'call_1',
  messageId: 'm2',
  chatId: C,
  name: 'shell',
  args: { command: 'npm test' },
  status,
  outputPreview: preview,
  outputTruncated: false,
  startedAt: 1,
  finishedAt: status === 'done' ? 2 : null
})

const run = (events: EngineEvent[], s: ChatViewState = initialChatState()): ChatViewState =>
  events.reduce((acc, e) => applyEngineEvent(acc, e, C), s)

describe('applyEngineEvent', () => {
  it('turn_started → deltas → message_added limpa streaming', () => {
    let s = run([
      { type: 'message_added', chatId: C, message: msg('m1', 1, 'user', 'oi') },
      { type: 'turn_started', chatId: C, requestId: 'r1', model: 'combo' },
      { type: 'reasoning_delta', chatId: C, requestId: 'r1', delta: 'pens' },
      { type: 'reasoning_delta', chatId: C, requestId: 'r1', delta: 'ando' },
      { type: 'text_delta', chatId: C, requestId: 'r1', delta: 'Olá' },
      { type: 'text_delta', chatId: C, requestId: 'r1', delta: ', mundo' }
    ])
    expect(s.streaming).toEqual({
      requestId: 'r1',
      text: 'Olá, mundo',
      reasoning: 'pensando',
      model: 'combo'
    })
    s = applyEngineEvent(
      s,
      { type: 'message_added', chatId: C, message: msg('m2', 2, 'assistant', 'Olá, mundo') },
      C
    )
    expect(s.streaming).toBeNull()
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('message_added repetido não duplica e mantém ordem por seq', () => {
    const s = run([
      { type: 'message_added', chatId: C, message: msg('m2', 2, 'assistant', 'b') },
      { type: 'message_added', chatId: C, message: msg('m1', 1, 'user', 'a') },
      { type: 'message_added', chatId: C, message: msg('m2', 2, 'assistant', 'b') }
    ])
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('tool_call_started / tool_output_delta / tool_call_finished', () => {
    let s = run([
      { type: 'tool_call_started', chatId: C, toolCall: tc('running') },
      { type: 'tool_output_delta', chatId: C, toolCallId: 'tc1', delta: 'linha 1\n' },
      { type: 'tool_output_delta', chatId: C, toolCallId: 'tc1', delta: 'linha 2\n' }
    ])
    expect(s.toolCalls.tc1.status).toBe('running')
    expect(s.toolCalls.tc1.liveOutput).toBe('linha 1\nlinha 2\n')
    s = applyEngineEvent(
      s,
      { type: 'tool_call_finished', chatId: C, toolCall: tc('done', 'ok') },
      C
    )
    expect(s.toolCalls.tc1).toMatchObject({
      status: 'done',
      outputPreview: 'ok',
      liveOutput: 'linha 1\nlinha 2\n'
    })
  })

  it('tool_call_started reemitido faz upsert por id (pending → awaiting_approval → running)', () => {
    const s = run([
      { type: 'tool_call_started', chatId: C, toolCall: tc('pending') },
      { type: 'tool_call_started', chatId: C, toolCall: tc('awaiting_approval') }
    ])
    expect(Object.keys(s.toolCalls)).toEqual(['tc1'])
    expect(s.toolCalls.tc1.status).toBe('awaiting_approval')
    const r = run(
      [
        { type: 'tool_output_delta', chatId: C, toolCallId: 'tc1', delta: 'x' },
        { type: 'tool_call_started', chatId: C, toolCall: tc('running') }
      ],
      s
    )
    expect(r.toolCalls.tc1).toMatchObject({ status: 'running', liveOutput: 'x' })
  })

  it('tool_output_delta de tool call desconhecida é ignorado', () => {
    const s0 = initialChatState()
    expect(
      applyEngineEvent(s0, { type: 'tool_output_delta', chatId: C, toolCallId: 'x', delta: 'a' }, C)
    ).toBe(s0)
  })

  it('provider_switched registra marcador depois da última mensagem', () => {
    const s = run([
      { type: 'message_added', chatId: C, message: msg('m1', 1, 'user', 'oi') },
      { type: 'provider_switched', chatId: C, from: 'a/x', to: 'b/y' }
    ])
    expect(s.modelSwitches).toEqual([{ afterSeq: 1, from: 'a/x', to: 'b/y' }])
  })

  it('evento de outro chat é ignorado', () => {
    const s0 = initialChatState()
    const events: EngineEvent[] = [
      { type: 'turn_started', chatId: 'outro', requestId: 'r', model: 'm' },
      { type: 'chat_status_changed', chatId: 'outro', status: 'running' },
      { type: 'turn_error', chatId: 'outro', message: 'x' },
      {
        type: 'context_updated',
        chatId: 'outro',
        context: { estTokens: 1, reportedTokens: null, effectiveWindow: null, limitingModel: null }
      }
    ]
    expect(run(events, s0)).toBe(s0)
  })

  it('turn_error preenche lastError e encerra streaming; nova mensagem do usuário limpa', () => {
    let s = run([
      { type: 'turn_started', chatId: C, requestId: 'r1', model: 'm' },
      { type: 'text_delta', chatId: C, requestId: 'r1', delta: 'x' },
      { type: 'turn_error', chatId: C, message: 'Configure a chave', code: 'AUTH' }
    ])
    expect(s.lastError).toEqual({ message: 'Configure a chave', code: 'AUTH' })
    expect(s.streaming).toBeNull()
    s = applyEngineEvent(
      s,
      { type: 'message_added', chatId: C, message: msg('m9', 9, 'user', 'de novo') },
      C
    )
    expect(s.lastError).toBeNull()
  })

  it('chat_status_changed e turn_finished', () => {
    const s = run([
      { type: 'chat_status_changed', chatId: C, status: 'running' },
      { type: 'turn_started', chatId: C, requestId: 'r1', model: 'm' },
      { type: 'turn_finished', chatId: C, requestId: 'r1' }
    ])
    expect(s.status).toBe('running')
    expect(s.streaming).toBeNull()
  })
})

describe('hydrateChatState', () => {
  it('mantém o que chegou por evento durante o carregamento', () => {
    const s = run([
      { type: 'message_added', chatId: C, message: msg('m3', 3, 'user', 'novo') },
      { type: 'tool_call_started', chatId: C, toolCall: tc('running') }
    ])
    const h = hydrateChatState(
      s,
      [msg('m1', 1, 'user', 'a'), msg('m2', 2, 'assistant', 'b')],
      [tc('pending')]
    )
    expect(h.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(h.toolCalls.tc1.status).toBe('running')
  })
})

describe('applyApprovalEvent', () => {
  const ap = (chatId: string, status: Approval['status']): Approval => ({
    id: 'a1',
    chatId,
    projectId: 'p',
    toolCallId: 'tc1',
    kind: 'command',
    summary: 'npm test',
    flags: [],
    status,
    decidedAt: null
  })
  it('adiciona, resolve e ignora outros chats', () => {
    let l = applyApprovalEvent({}, { type: 'permission_requested', approval: ap(C, 'pending') }, C)
    expect(l.a1.status).toBe('pending')
    l = applyApprovalEvent(l, { type: 'permission_resolved', approval: ap(C, 'allowed') }, C)
    expect(l.a1.status).toBe('allowed')
    const same = applyApprovalEvent(
      l,
      { type: 'permission_requested', approval: { ...ap('outro', 'pending'), id: 'a2' } },
      C
    )
    expect(same).toBe(l)
  })
})

describe('compactação', () => {
  const rec = (
    id: string,
    fromSeq: number,
    toSeq: number,
    summaryMessageId: string,
    previousCompactionId: string | null = null,
    createdAt = 10
  ): CompactionRecord => ({
    id,
    chatId: C,
    fromSeq,
    toSeq,
    summaryMessageId,
    previousCompactionId,
    summarizerModel: 'light',
    tokensBefore: 5000,
    tokensAfter: 1200,
    trigger: 'auto',
    createdAt
  })
  const summary = (id: string, seq: number): StoredMessage => ({
    ...msg(id, seq, 'user', '[Summary of the earlier conversation — use it as context]\n\n## Goal'),
    kind: 'summary'
  })
  const base = (): ChatViewState =>
    run(
      [1, 2, 3, 4, 5, 6].map((i) => ({
        type: 'message_added' as const,
        chatId: C,
        message: msg(`m${i}`, i, i % 2 ? 'user' : 'assistant', `t${i}`)
      }))
    )

  it('started liga compacting; finished marca o intervalo, insere o summary e desliga', () => {
    let s = run([{ type: 'compaction_started', chatId: C, trigger: 'auto' }], base())
    expect(s.compacting).toBe(true)
    s = applyEngineEvent(
      s,
      {
        type: 'compaction_finished',
        chatId: C,
        compaction: rec('c1', 1, 4, 's1'),
        summaryMessage: summary('s1', 7)
      },
      C
    )
    expect(s.compacting).toBe(false)
    expect(s.messages.filter((m) => m.compacted).map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(s.messages.find((m) => m.id === 's1')?.kind).toBe('summary')
    expect(s.compactions.map((r) => r.id)).toEqual(['c1'])

    const tl = buildTimeline(s.messages, s.compactions)
    // Tudo continua na timeline, por seq; o divisor entra logo após o toSeq; o summary não é balão.
    expect(
      tl.map((i) =>
        i.type === 'message' ? `${i.message.id}${i.message.compacted ? '*' : ''}` : i.type
      )
    ).toEqual(['m1*', 'm2*', 'm3*', 'm4*', 'compaction', 'm5', 'm6'])
    expect(compactedCount(rec('c1', 1, 4, 's1'))).toBe(4)
  })

  it('segunda compactação absorve o summary anterior; o divisor antigo fica superseded', () => {
    let s = run(
      [
        {
          type: 'compaction_finished',
          chatId: C,
          compaction: rec('c1', 1, 4, 's1'),
          summaryMessage: summary('s1', 7)
        },
        { type: 'message_added', chatId: C, message: msg('m8', 8, 'user', 'mais') },
        { type: 'compaction_started', chatId: C, trigger: 'manual' },
        {
          type: 'compaction_finished',
          chatId: C,
          compaction: rec('c2', 5, 7, 's2', 'c1', 20),
          summaryMessage: summary('s2', 9)
        }
      ],
      base()
    )
    expect(s.compacting).toBe(false)
    expect(s.messages.find((m) => m.id === 's1')?.compacted).toBe(true)
    const tl = buildTimeline(s.messages, s.compactions)
    expect(
      tl.map((i) =>
        i.type === 'message'
          ? `${i.message.id}${i.message.compacted ? '*' : ''}`
          : i.type === 'compaction'
            ? `${i.record.id}${i.superseded ? '(old)' : ''}`
            : i.type
      )
    ).toEqual(['m1*', 'm2*', 'm3*', 'm4*', 'c1(old)', 'm5*', 'm6*', 'c2', 'm8'])
    expect(compactedCount(rec('c2', 5, 7, 's2', 'c1'))).toBe(2)
    s = hydrateCompactions(s, [rec('c1', 1, 4, 's1')])
    expect(s.compactions.map((r) => r.id)).toEqual(['c1', 'c2'])
  })

  it('recarga: messages.list traz as compactadas e a timeline mantém a ordem', () => {
    const compacted = [1, 2, 3, 4].map((i) => ({
      ...msg(`m${i}`, i, i % 2 ? 'user' : 'assistant', `t${i}`),
      compacted: true
    }))
    let s = hydrateChatState(
      initialChatState(),
      [...compacted, msg('m5', 5, 'user', 't5'), msg('m6', 6, 'assistant', 't6'), summary('s1', 7)],
      []
    )
    s = hydrateCompactions(s, [rec('c1', 1, 4, 's1')])
    const tl = buildTimeline(s.messages, s.compactions)
    expect(
      tl.map((i) =>
        i.type === 'message' ? `${i.message.id}${i.message.compacted ? '*' : ''}` : i.type
      )
    ).toEqual(['m1*', 'm2*', 'm3*', 'm4*', 'compaction', 'm5', 'm6'])
  })

  it('compaction_failed desliga compacting e preenche lastError', () => {
    const s = run([
      { type: 'compaction_started', chatId: C, trigger: 'auto' },
      { type: 'compaction_failed', chatId: C, message: 'todos os modelos falharam' }
    ])
    expect(s.compacting).toBe(false)
    expect(s.lastError?.code).toBe('COMPACTION_FAILED')
    expect(s.lastError?.message).toContain('todos os modelos falharam')
  })

  it('summary sem registro conhecido aparece como divisor no próprio seq', () => {
    const s = run([{ type: 'message_added', chatId: C, message: summary('s1', 7) }], base())
    const tl = buildTimeline(s.messages, s.compactions)
    expect(tl.map((i) => (i.type === 'message' ? i.message.id : i.type))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'summary'
    ])
  })
})
