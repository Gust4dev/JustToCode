import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, LoaderCircle, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import type { Approval, Chat, QueueState } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { errorMessage, findAnyChat, useProjects } from '@renderer/features/projects/store'
import { useUi } from '@renderer/stores/ui'
import { toUpload, sentPreviews, type DraftAttachment } from './attachments'
import {
  applyApprovalEvent,
  applyEngineEvent,
  hydrateChatState,
  hydrateCompactions,
  hydrateMemories,
  hydrateQueue,
  initialChatState,
  updateMemoryMark,
  type ChatViewState
} from './chatStore'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { ContinuationChip } from './ContinuationChip'
import { MessageList, type MemoryChange, type PendingMessage } from './MessageList'
import { QueuePanel } from './QueuePanel'
import { SubagentContext } from './SubagentContext'
import {
  applySubagentEvent,
  hydrateSubagents,
  matchSubagentChildren,
  type SubagentMap
} from './subagents'

const BOTTOM_SLACK = 48

const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code
const NO_CHATS: Chat[] = []

function SubagentBanner({ parentChatId }: { parentChatId: string }): React.JSX.Element {
  const parent = useProjects((s) => findAnyChat(s, parentChatId))
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
      <Bot className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        subagente de{' '}
        <button
          type="button"
          className="font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => useUi.getState().selectChat(parentChatId)}
        >
          {parent?.title ?? 'chat pai'}
        </button>
      </span>
      <span className="shrink-0">somente leitura</span>
    </div>
  )
}

export function ChatView({ chatId }: { chatId: string }): React.JSX.Element {
  const [state, setState] = useState<ChatViewState>(() =>
    initialChatState(findAnyChat(useProjects.getState(), chatId)?.status ?? 'idle')
  )
  const chat = useProjects((s) => findAnyChat(s, chatId))
  const uiProjectId = useUi((s) => s.projectId)
  const projectId = chat?.projectId ?? uiProjectId
  const parentChatId = chat?.parentChatId ?? null
  const childChats = useProjects((s) => s.children[chatId] ?? NO_CHATS)
  const [subagentEvents, setSubagentEvents] = useState<SubagentMap>({})
  const subagents = useMemo(
    () =>
      hydrateSubagents(
        subagentEvents,
        matchSubagentChildren(Object.values(state.toolCalls), childChats)
      ),
    [subagentEvents, state.toolCalls, childChats]
  )
  const [approvals, setApprovals] = useState<Record<string, Approval>>({})
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingMessage | null>(null)
  /** Prévias da mensagem em envio; vão para `sentPreviews` quando a mensagem do usuário chega. */
  const outgoing = useRef<string[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  /** O próximo envio provavelmente vai para a fila (chat rodando ou fila com itens/pausada). */
  const willQueue = useRef(false)
  const busy = state.status === 'running' || state.status === 'waiting_approval'
  useEffect(() => {
    willQueue.current =
      busy || !!state.queue?.paused || (state.queue ? state.queue.items.length > 0 : false)
  }, [busy, state.queue])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [messages, toolCalls, list] = await Promise.all([
          call('messages.list', { chatId }),
          call('toolCalls.list', { chatId }),
          call('approvals.list', { chatId }).catch(() => [] as Approval[])
        ])
        if (!alive) return
        setState((s) => hydrateChatState(s, messages, toolCalls))
        setApprovals((cur) => {
          const next: Record<string, Approval> = {}
          for (const a of list) next[a.id] = a
          return { ...next, ...cur }
        })
        setLoadError(null)
        // Compactações são opcionais: sem o handler (host antigo), a lista fica só com os eventos.
        call('compaction.list', { chatId })
          .then((records) => alive && setState((s) => hydrateCompactions(s, records)))
          .catch(() => undefined)
        // Memórias salvas a partir deste chat (cards da timeline); host sem o método → só eventos.
        call('instructions.list', { chatId, kind: 'memory' })
          .then((list) => alive && setState((s) => hydrateMemories(s, list, chatId)))
          .catch(() => undefined)
        // Fila idem: host sem `queue.get` → só eventos.
        call('queue.get', { chatId })
          .then((q) => alive && setState((s) => hydrateQueue(s, q)))
          .catch(() => undefined)
      } catch (e) {
        if (alive) setLoadError(errorMessage(e))
      } finally {
        if (alive) setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [chatId])

  useEngineEvent((e) => {
    if (
      e.type === 'message_added' &&
      e.message.chatId === chatId &&
      e.message.message.role === 'user' &&
      e.message.kind !== 'summary' &&
      outgoing.current
    ) {
      if (outgoing.current.length > 0) sentPreviews.set(e.message.id, outgoing.current)
      outgoing.current = null
      setPending(null)
    }
    setState((s) => applyEngineEvent(s, e, chatId))
    setApprovals((l) => applyApprovalEvent(l, e, chatId))
    setSubagentEvents((m) => applySubagentEvent(m, e, chatId))
  })

  // Auto-scroll só quando o usuário já está no fim.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [state, pending, approvals, loaded])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK
  }

  const send = useCallback(
    async (text: string, attachments: DraftAttachment[]): Promise<boolean> => {
      atBottom.current = true
      const queueing = willQueue.current
      if (!queueing) {
        outgoing.current = attachments.map((a) => a.dataUrl)
        setPending({
          text,
          receipts: attachments.map((a) => ({ name: a.name, bytes: a.bytes, preview: a.dataUrl }))
        })
      }
      try {
        const { messageId, queuedId } = await call('engine.send', {
          chatId,
          text,
          attachments: attachments.map(toUpload)
        })
        if (queuedId) {
          // Foi para a fila: nada de balão pendente; a faixa da fila mostra o item.
          if (!queueing) {
            outgoing.current = null
            setPending(null)
          }
          call('queue.get', { chatId })
            .then((q: QueueState) => setState((s) => ({ ...s, queue: q })))
            .catch(() => undefined)
          return true
        }
        // Se o evento message_added ainda não chegou, guarda as prévias pelo id devolvido.
        if (!queueing && outgoing.current) {
          if (messageId && outgoing.current.length > 0) {
            sentPreviews.set(messageId, outgoing.current)
          }
          outgoing.current = null
          setPending(null)
        }
        return true
      } catch (e) {
        if (!queueing) {
          outgoing.current = null
          setPending(null)
        }
        const code = codeOf(e)
        toast.error(
          code === 'CHAT_BUSY'
            ? 'O chat ainda está rodando.'
            : `Não foi possível enviar: ${errorMessage(e)}`
        )
        return false
      }
    },
    [chatId]
  )

  const stop = useCallback((): void => {
    call('engine.cancel', { chatId }).catch((e) =>
      toast.error(`Não foi possível parar: ${errorMessage(e)}`)
    )
  }, [chatId])

  const continueTurn = useCallback((): void => {
    call('engine.continue', { chatId }).catch((e: unknown) =>
      toast.error(
        codeOf(e) === 'UNKNOWN_METHOD'
          ? 'Continuar ainda não está disponível no agent-host.'
          : `Não foi possível continuar: ${errorMessage(e)}`
      )
    )
  }, [chatId])

  const onQueue = useCallback((q: QueueState) => setState((s) => ({ ...s, queue: q })), [])
  const onMemoryChange = useCallback(
    (toolCallId: string, change: MemoryChange) =>
      setState((s) => updateMemoryMark(s, toolCallId, change)),
    []
  )

  const empty =
    !parentChatId &&
    loaded &&
    !pending &&
    !state.streaming &&
    !state.lastError &&
    !state.paused &&
    !state.messages.some((m) => m.message.role === 'user' || m.message.role === 'assistant')

  return (
    <div className="flex h-full flex-col" data-chat-id={chatId}>
      {parentChatId && <SubagentBanner parentChatId={parentChatId} />}
      {!parentChatId && chat && (
        <ChatHeader chat={chat} budget={state.budget} reasoning={state.reasoning} />
      )}
      {chat?.continuedFromChatId && (
        <ContinuationChip fromChatId={chat.continuedFromChatId} messages={state.messages} />
      )}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {loadError ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
            Não foi possível carregar a conversa: {loadError}
          </div>
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="size-5" />
            Envie uma mensagem para começar
          </div>
        ) : (
          <SubagentContext.Provider value={subagents}>
            <MessageList
              state={state}
              approvals={approvals}
              pending={pending}
              onContinue={parentChatId ? undefined : continueTurn}
              onMemoryChange={onMemoryChange}
            />
          </SubagentContext.Provider>
        )}
      </div>
      {state.compacting && (
        <div
          role="status"
          className="flex items-center justify-center gap-1.5 py-1 text-[11px] text-muted-foreground"
        >
          <LoaderCircle className="size-3 animate-spin" />
          compactando contexto…
        </div>
      )}
      {parentChatId ? (
        busy && (
          <div className="flex shrink-0 items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            subagente trabalhando…
          </div>
        )
      ) : (
        <Composer
          chatId={chatId}
          projectId={projectId}
          busy={busy}
          onSend={send}
          onStop={stop}
          top={<QueuePanel queue={state.queue} onQueue={onQueue} />}
        />
      )}
    </div>
  )
}
