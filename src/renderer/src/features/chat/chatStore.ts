import type {
  Approval,
  ChatStatus,
  CompactionRecord,
  CompactionTrigger,
  StoredMessage,
  ToolCallRecord
} from '@shared/domain'
import type { EngineEvent } from '@shared/events'

// Reducer puro da conversa. Só importa de @shared para rodar nos testes (Vitest, ambiente node).

export type LiveToolCall = ToolCallRecord & { liveOutput: string }

export interface ChatViewState {
  messages: StoredMessage[]
  streaming: { requestId: string; text: string; reasoning: string; model: string } | null
  toolCalls: Record<string, LiveToolCall>
  status: ChatStatus
  lastError: { message: string; code?: string } | null
  modelSwitches: { afterSeq: number; from: string | null; to: string }[]
  /** Uma compactação está em andamento (entre `compaction_started` e o fim). */
  compacting: boolean
  /** Registros de compactação do chat, por `createdAt`. */
  compactions: CompactionRecord[]
}

export function initialChatState(status: ChatStatus = 'idle'): ChatViewState {
  return {
    messages: [],
    streaming: null,
    toolCalls: {},
    status,
    lastError: null,
    modelSwitches: [],
    compacting: false,
    compactions: []
  }
}

function mergeMessages(list: StoredMessage[], add: StoredMessage[]): StoredMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]))
  for (const m of add) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

const lastSeq = (s: ChatViewState): number => s.messages[s.messages.length - 1]?.seq ?? 0

/** Junta o resultado de `messages.list` + `toolCalls.list` com o que já chegou por evento. */
export function hydrateChatState(
  s: ChatViewState,
  messages: StoredMessage[],
  toolCalls: ToolCallRecord[]
): ChatViewState {
  const next: Record<string, LiveToolCall> = {}
  for (const tc of toolCalls) next[tc.id] = { ...tc, liveOutput: '' }
  // Eventos recebidos durante o carregamento são mais novos que a lista.
  for (const [id, tc] of Object.entries(s.toolCalls)) next[id] = tc
  return { ...s, messages: mergeMessages(messages, s.messages), toolCalls: next }
}

function mergeCompactions(list: CompactionRecord[], add: CompactionRecord[]): CompactionRecord[] {
  const byId = new Map(list.map((r) => [r.id, r]))
  for (const r of add) byId.set(r.id, r)
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.toSeq - b.toSeq)
}

/** Junta o resultado de `compaction.list` com o que já chegou por evento. */
export function hydrateCompactions(s: ChatViewState, records: CompactionRecord[]): ChatViewState {
  return { ...s, compactions: mergeCompactions(records, s.compactions) }
}

export const TRIGGER_LABEL: Record<CompactionTrigger, string> = {
  auto: 'automático',
  manual: 'manual',
  overflow: 'estouro de janela'
}

/** Quantas mensagens uma compactação escondeu (sem contar o resumo anterior que ela absorveu). */
export function compactedCount(r: CompactionRecord): number {
  return Math.max(0, r.toSeq - r.fromSeq + 1 - (r.previousCompactionId ? 1 : 0))
}

export type TimelineItem =
  | { type: 'message'; message: StoredMessage }
  | { type: 'compaction'; record: CompactionRecord; superseded: boolean }
  | { type: 'summary'; message: StoredMessage }

/**
 * Timeline principal: TODAS as mensagens de conversa (compactadas ou não) por seq; as compactadas
 * saem com `message.compacted` e a UI as esmaece. Cada compactação vira um divisor logo depois do
 * último seq que ela cobriu (onde aconteceu); as absorvidas por uma posterior ficam `superseded`.
 * Mensagens `kind: 'summary'` nunca aparecem como balão: com registro, o divisor as representa;
 * sem registro conhecido (ex.: `compaction.list` indisponível), viram divisor no próprio seq.
 */
export function buildTimeline(
  messages: StoredMessage[],
  compactions: CompactionRecord[]
): TimelineItem[] {
  const withRecord = new Set(compactions.map((r) => r.summaryMessageId))
  const absorbed = new Set(
    compactions.map((r) => r.previousCompactionId).filter((id): id is string => !!id)
  )
  const keyed: { key: number; order: number; item: TimelineItem }[] = []
  for (const m of messages) {
    if (m.kind === 'summary') {
      if (!withRecord.has(m.id))
        keyed.push({ key: m.seq, order: 0, item: { type: 'summary', message: m } })
      continue
    }
    if (m.message.role !== 'user' && m.message.role !== 'assistant') continue
    keyed.push({ key: m.seq, order: 0, item: { type: 'message', message: m } })
  }
  compactions.forEach((r, i) =>
    keyed.push({
      // Entre toSeq e toSeq + 1.
      key: r.toSeq + 0.5,
      order: i,
      item: { type: 'compaction', record: r, superseded: absorbed.has(r.id) }
    })
  )
  return keyed.sort((a, b) => a.key - b.key || a.order - b.order).map((k) => k.item)
}

export function applyEngineEvent(s: ChatViewState, e: EngineEvent, chatId: string): ChatViewState {
  if (!('chatId' in e) || e.chatId !== chatId) return s
  switch (e.type) {
    case 'chat_status_changed':
      return e.status === s.status ? s : { ...s, status: e.status }
    case 'message_added': {
      const m = e.message
      return {
        ...s,
        messages: mergeMessages(s.messages, [m]),
        streaming: m.message.role === 'assistant' ? null : s.streaming,
        lastError: m.message.role === 'user' ? null : s.lastError
      }
    }
    case 'turn_started':
      return {
        ...s,
        streaming: { requestId: e.requestId, text: '', reasoning: '', model: e.model },
        lastError: null
      }
    case 'text_delta':
    case 'reasoning_delta': {
      const cur =
        s.streaming && s.streaming.requestId === e.requestId
          ? s.streaming
          : { requestId: e.requestId, text: '', reasoning: '', model: s.streaming?.model ?? '' }
      const streaming =
        e.type === 'text_delta'
          ? { ...cur, text: cur.text + e.delta }
          : { ...cur, reasoning: cur.reasoning + e.delta }
      return { ...s, streaming }
    }
    case 'tool_call_started':
    case 'tool_call_finished': {
      const prev = s.toolCalls[e.toolCall.id]
      return {
        ...s,
        toolCalls: {
          ...s.toolCalls,
          [e.toolCall.id]: { ...e.toolCall, liveOutput: prev?.liveOutput ?? '' }
        }
      }
    }
    case 'tool_output_delta': {
      const prev = s.toolCalls[e.toolCallId]
      if (!prev) return s
      return {
        ...s,
        toolCalls: {
          ...s.toolCalls,
          [e.toolCallId]: { ...prev, liveOutput: prev.liveOutput + e.delta }
        }
      }
    }
    case 'provider_switched':
      return {
        ...s,
        modelSwitches: [...s.modelSwitches, { afterSeq: lastSeq(s), from: e.from, to: e.to }]
      }
    case 'turn_finished':
      return { ...s, streaming: null }
    case 'turn_error':
      return { ...s, streaming: null, lastError: { message: e.message, code: e.code } }
    case 'compaction_started':
      return s.compacting ? s : { ...s, compacting: true }
    case 'compaction_finished': {
      const { fromSeq, toSeq } = e.compaction
      const marked = s.messages.map((m) =>
        !m.compacted && m.seq >= fromSeq && m.seq <= toSeq ? { ...m, compacted: true } : m
      )
      return {
        ...s,
        compacting: false,
        messages: mergeMessages(marked, [e.summaryMessage]),
        compactions: mergeCompactions(s.compactions, [e.compaction])
      }
    }
    case 'compaction_failed':
      return {
        ...s,
        compacting: false,
        lastError: { message: `A compactação falhou: ${e.message}`, code: 'COMPACTION_FAILED' }
      }
    default:
      return s
  }
}

/** Aprovações do chat, por id. Pura; ignora aprovações de outros chats. */
export function applyApprovalEvent(
  list: Record<string, Approval>,
  e: EngineEvent,
  chatId: string
): Record<string, Approval> {
  if (e.type !== 'permission_requested' && e.type !== 'permission_resolved') return list
  if (e.approval.chatId !== chatId) return list
  return { ...list, [e.approval.id]: e.approval }
}
