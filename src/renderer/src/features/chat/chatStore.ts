import type {
  Approval,
  ChatStatus,
  CompactionRecord,
  CompactionTrigger,
  Instruction,
  QueueState,
  ReasoningLevel,
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
  modelSwitches: ModelSwitchMark[]
  /** Uma compactação está em andamento (entre `compaction_started` e o fim). */
  compacting: boolean
  /** Registros de compactação do chat, por `createdAt`. */
  compactions: CompactionRecord[]
  /** Fila de mensagens do chat (`queue.get` / `queue_changed`); null = ainda não carregada. */
  queue: QueueState | null
  /** Último `budget_updated` do turno corrente. */
  budget: BudgetState | null
  /** Motivo do último `turn_paused` (limpo quando um turno novo começa). */
  paused: PauseReason | null
  /** Memórias salvas a partir deste chat (carregadas + `memory_saved`), por criação. */
  memories: MemoryMark[]
  /** Último `reasoning_status` do chat. */
  reasoning: ReasoningStatus | null
}

export interface MemoryMark {
  toolCallId: string
  instruction: Instruction
  created: boolean
  /** Quando o evento chegou (ms), para o destaque. */
  at: number
  /** seq da última mensagem quando chegou (âncora quando a tool call não é conhecida). */
  afterSeq: number
  /** Desfeita via `memory.undo`. */
  undone: boolean
}

export interface ReasoningStatus {
  requestId: string
  requested: ReasoningLevel | null
  confirmed: boolean
}

export interface ModelSwitchMark {
  afterSeq: number
  from: string | null
  to: string
  /** Janela do modelo novo, quando o engine informa. */
  window: number | null
}

export interface BudgetState {
  used: number
  budget: number | null
  iterations: number
  maxIterations: number | null
}

export type PauseReason = 'budget' | 'iterations'

export function initialChatState(status: ChatStatus = 'idle'): ChatViewState {
  return {
    messages: [],
    streaming: null,
    toolCalls: {},
    status,
    lastError: null,
    modelSwitches: [],
    compacting: false,
    compactions: [],
    queue: null,
    budget: null,
    paused: null,
    memories: [],
    reasoning: null
  }
}

/** Aplica uma mudança local a um card de memória (editado → nova instrução; desfeito). */
export function updateMemoryMark(
  s: ChatViewState,
  toolCallId: string,
  patch: Partial<Pick<MemoryMark, 'instruction' | 'undone'>>
): ChatViewState {
  if (!s.memories.some((m) => m.toolCallId === toolCallId)) return s
  return {
    ...s,
    memories: s.memories.map((m) => (m.toolCallId === toolCallId ? { ...m, ...patch } : m))
  }
}

/**
 * seq da mensagem depois da qual uma memória salva vai na timeline: a última mensagem do request
 * que a salvou (`origin.requestId`); sem ele, a última mensagem criada até `createdAt`; 0 = topo.
 */
export function memoryAnchorSeq(messages: StoredMessage[], inst: Instruction): number {
  const requestId = inst.origin?.requestId ?? null
  let byRequest = 0
  let byTime = 0
  for (const m of messages) {
    if (requestId && m.requestId === requestId) byRequest = Math.max(byRequest, m.seq)
    if (m.createdAt <= inst.createdAt) byTime = Math.max(byTime, m.seq)
  }
  return byRequest || byTime
}

/**
 * Junta as memórias salvas a partir deste chat (`instructions.list` com `kind: 'memory'`) aos
 * cards; dedupe por id da instrução (um card por memória; o que chegou por evento vence).
 * Chame depois de hidratar as mensagens, para ancorar pela ordem de criação.
 */
export function hydrateMemories(
  s: ChatViewState,
  list: Instruction[],
  chatId: string
): ChatViewState {
  const known = new Set(s.memories.map((m) => m.instruction.id))
  const add: MemoryMark[] = list
    .filter((i) => i.kind === 'memory' && i.origin?.chatId === chatId && !known.has(i.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((i) => ({
      toolCallId: `memory:${i.id}`,
      instruction: i,
      created: i.createdAt === i.updatedAt,
      // Antigas: sem destaque.
      at: i.updatedAt,
      afterSeq: memoryAnchorSeq(s.messages, i),
      undone: false
    }))
  if (add.length === 0) return s
  const memories = [...add, ...s.memories].sort(
    (a, b) => a.instruction.createdAt - b.instruction.createdAt
  )
  return { ...s, memories }
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

/** Junta o resultado de `queue.get`; um `queue_changed` já recebido vence a lista. */
export function hydrateQueue(s: ChatViewState, queue: QueueState): ChatViewState {
  return s.queue ? s : { ...s, queue }
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

export function applyEngineEvent(
  s: ChatViewState,
  e: EngineEvent,
  chatId: string,
  now: number = Date.now()
): ChatViewState {
  if (e.type === 'queue_changed') return e.queue.chatId === chatId ? { ...s, queue: e.queue } : s
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
        lastError: m.message.role === 'user' ? null : s.lastError,
        paused: m.message.role === 'user' ? null : s.paused
      }
    }
    case 'turn_started':
      return {
        ...s,
        streaming: { requestId: e.requestId, text: '', reasoning: '', model: e.model },
        lastError: null,
        paused: null
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
        modelSwitches: [
          ...s.modelSwitches,
          { afterSeq: lastSeq(s), from: e.from, to: e.to, window: e.window ?? null }
        ]
      }
    case 'budget_updated':
      return {
        ...s,
        budget: {
          used: e.used,
          budget: e.budget,
          iterations: e.iterations,
          maxIterations: e.maxIterations
        }
      }
    case 'turn_paused':
      return { ...s, streaming: null, paused: e.reason }
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
    case 'memory_saved': {
      const mark: MemoryMark = {
        toolCallId: e.toolCallId,
        instruction: e.instruction,
        created: e.created,
        at: now,
        afterSeq: lastSeq(s),
        undone: false
      }
      const i = s.memories.findIndex((m) => m.toolCallId === e.toolCallId)
      if (i >= 0)
        return {
          ...s,
          memories: s.memories.map((m, j) => (j === i ? { ...mark, afterSeq: m.afterSeq } : m))
        }
      // Mesma memória já mostrada (carregada ou de outra tool call): um card só, no ponto novo.
      const rest = s.memories.filter((m) => m.instruction.id !== e.instruction.id)
      return { ...s, memories: [...rest, mark] }
    }
    case 'reasoning_status':
      return {
        ...s,
        reasoning: { requestId: e.requestId, requested: e.requested, confirmed: e.confirmed }
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
