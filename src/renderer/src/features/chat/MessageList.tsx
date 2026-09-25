import { Fragment, useMemo, useState } from 'react'
import {
  ArrowRight,
  CircleSlash,
  ExternalLink,
  Layers,
  LoaderCircle,
  Pause,
  Play,
  Settings,
  TriangleAlert
} from 'lucide-react'
import type { Approval, Instruction } from '@shared/domain'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { openSettings } from '@renderer/stores/settingsDialog'
import { openExternal } from '@renderer/features/components/hooks'
import { ROUTER_DASHBOARD } from '@renderer/features/components/format'
import { errorAction, splitInlineCode } from './errorBanner'
import {
  buildTimeline,
  type ChatViewState,
  type LiveToolCall,
  type MemoryMark,
  type PauseReason
} from './chatStore'
import { MemoryCard } from '@renderer/features/instructions/MemoryCard'
import { formatTokens } from '@renderer/features/context/format'
import { PAUSE_LABEL } from './runControls'
import { CompactionDialog, type CompactionTarget } from './CompactionDialog'
import { CompactionDivider } from './CompactionDivider'
import { Markdown } from './Markdown'
import { MessageItem, Reasoning, UserBubble, type ReceiptItem } from './MessageItem'
import { ToolCallCard } from './ToolCallCard'

const NO_CALLS: LiveToolCall[] = []
const NO_MEMORIES: MemoryMark[] = []

export type MemoryChange = Partial<{ instruction: Instruction; undone: boolean }>

export interface PendingMessage {
  text: string
  receipts: ReceiptItem[]
}

function Divider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <div className="flex items-center gap-1.5">{children}</div>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function ModelSwitch({
  from,
  to,
  window
}: {
  from: string | null
  to: string
  window: number | null
}): React.JSX.Element {
  return (
    <Divider>
      modelo mudou:
      <span className="font-mono">{from ?? '—'}</span>
      <ArrowRight className="size-3" />
      <span className="font-mono">{to}</span>
      {window !== null && (
        <span title={`Janela de ${window.toLocaleString('pt-BR')} tokens`}>
          · janela {formatTokens(window)}
        </span>
      )}
    </Divider>
  )
}

function PausedCard({
  reason,
  onContinue
}: {
  reason: PauseReason
  onContinue(): void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
    >
      <Pause className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="min-w-0 flex-1">{PAUSE_LABEL[reason]}</p>
      <Button variant="outline" size="xs" className="shrink-0" onClick={onContinue}>
        <Play />
        Continuar
      </Button>
    </div>
  )
}

function ErrorBanner({ error }: { error: { message: string; code?: string } }): React.JSX.Element {
  const action = errorAction(error.code)
  if (error.code === 'CANCELLED')
    return (
      <Divider>
        <CircleSlash className="size-3" />
        interrompido
      </Divider>
    )
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {splitInlineCode(error.message).map((seg, i) =>
          seg.code ? (
            <code key={i} className="rounded bg-destructive/10 px-1 font-mono">
              {seg.text}
            </code>
          ) : (
            <Fragment key={i}>{seg.text}</Fragment>
          )
        )}
      </p>
      {action === 'router-dashboard' && (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 text-foreground"
          onClick={() => openExternal(ROUTER_DASHBOARD)}
        >
          <ExternalLink />
          Abrir dashboard do 9router
        </Button>
      )}
      {action === 'settings' && (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 text-foreground"
          onClick={openSettings}
        >
          <Settings />
          Abrir configurações
        </Button>
      )}
    </div>
  )
}

export function MessageList({
  state,
  approvals,
  pending,
  onContinue,
  onMemoryChange
}: {
  state: ChatViewState
  approvals: Record<string, Approval>
  pending: PendingMessage | null
  /** Retoma um turno pausado (`engine.continue`); sem ele o card não mostra o botão. */
  onContinue?(): void
  /** Card de memória editado/desfeito. */
  onMemoryChange?(toolCallId: string, change: MemoryChange): void
}): React.JSX.Element {
  const { messages, toolCalls, streaming, modelSwitches, lastError, status, compactions, paused } =
    state
  const memories = state.memories ?? NO_MEMORIES

  // Cada card de memória vai depois da mensagem da tool call; sem ela, depois do seq em que chegou.
  const memoryAnchors = useMemo(() => {
    const ids = new Set(messages.map((m) => m.id))
    // Só mensagens que viram balão ancoram (tool/summary não aparecem como mensagem).
    const shownSeqs = messages
      .filter(
        (m) => m.kind !== 'summary' && (m.message.role === 'user' || m.message.role === 'assistant')
      )
      .map((m) => m.seq)
    const anchorSeq = (seq: number): number =>
      shownSeqs.reduce((best, x) => (x <= seq && x > best ? x : best), 0)
    const byMessage = new Map<string, MemoryMark[]>()
    const bySeq = new Map<number, MemoryMark[]>()
    for (const mk of memories) {
      const mid = toolCalls[mk.toolCallId]?.messageId
      if (mid && ids.has(mid)) byMessage.set(mid, [...(byMessage.get(mid) ?? []), mk])
      else {
        const k = anchorSeq(mk.afterSeq)
        bySeq.set(k, [...(bySeq.get(k) ?? []), mk])
      }
    }
    return { byMessage, bySeq }
  }, [memories, messages, toolCalls])

  const memoryCards = (list: MemoryMark[] | undefined): React.ReactNode =>
    list?.map((mk) => (
      <MemoryCard
        key={`mem-${mk.toolCallId}`}
        instruction={mk.instruction}
        created={mk.created}
        at={mk.at}
        undone={mk.undone}
        onEdited={(i) => onMemoryChange?.(mk.toolCallId, { instruction: i })}
        onUndone={() => onMemoryChange?.(mk.toolCallId, { undone: true })}
      />
    ))

  const { byMessage, orphans } = useMemo(() => {
    const ids = new Set(messages.map((m) => m.id))
    const byMessage = new Map<string, LiveToolCall[]>()
    const orphans: LiveToolCall[] = []
    for (const tc of Object.values(toolCalls)) {
      if (!ids.has(tc.messageId)) {
        orphans.push(tc)
        continue
      }
      const list = byMessage.get(tc.messageId) ?? []
      list.push(tc)
      byMessage.set(tc.messageId, list)
    }
    return { byMessage, orphans }
  }, [messages, toolCalls])

  const approvalsByTool = useMemo(() => {
    const r: Record<string, Approval> = {}
    for (const a of Object.values(approvals)) r[a.toolCallId] = a
    return r
  }, [approvals])

  const timeline = useMemo(() => buildTimeline(messages, compactions), [messages, compactions])
  const [opened, setOpened] = useState<CompactionTarget | null>(null)

  const busy = status === 'running' || status === 'waiting_approval'
  const lastItem = timeline[timeline.length - 1]
  const lastIsUser = lastItem?.type === 'message' && lastItem.message.message.role === 'user'

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
      {modelSwitches
        .filter((s) => s.afterSeq === 0)
        .map((s, i) => (
          <ModelSwitch key={`s0-${i}`} from={s.from} to={s.to} window={s.window} />
        ))}
      {memoryCards(memoryAnchors.bySeq.get(0))}
      {timeline.map((item) => {
        if (item.type === 'compaction')
          return (
            <CompactionDivider
              key={`c-${item.record.id}`}
              record={item.record}
              superseded={item.superseded}
              onOpen={() => setOpened({ kind: 'record', id: item.record.id })}
            />
          )
        if (item.type === 'summary')
          return (
            <CompactionDivider
              key={item.message.id}
              record={null}
              onOpen={() => setOpened({ kind: 'summary', message: item.message })}
            />
          )
        const m = item.message
        const body = (
          <MessageItem
            message={m}
            toolCalls={byMessage.get(m.id) ?? NO_CALLS}
            approvals={approvalsByTool}
          />
        )
        return (
          <Fragment key={m.id}>
            {m.compacted ? (
              <div
                data-compacted
                className="flex flex-col gap-1 opacity-60"
                title="Compactada: não vai mais no request (está no resumo)"
              >
                <span
                  className={cn(
                    'flex items-center gap-1 text-[10px] text-muted-foreground',
                    m.message.role === 'user' && 'self-end'
                  )}
                >
                  <Layers className="size-2.5" />
                  compactada
                </span>
                {body}
              </div>
            ) : (
              body
            )}
            {memoryCards(memoryAnchors.byMessage.get(m.id))}
            {memoryCards(memoryAnchors.bySeq.get(m.seq))}
            {modelSwitches
              .filter((s) => s.afterSeq === m.seq)
              .map((s, i) => (
                <ModelSwitch key={`s${m.seq}-${i}`} from={s.from} to={s.to} window={s.window} />
              ))}
          </Fragment>
        )
      })}
      {orphans.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {orphans.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} approval={approvalsByTool[tc.id]} />
          ))}
        </div>
      )}
      {pending && <UserBubble text={pending.text} receipts={pending.receipts} confirmed={false} />}
      {streaming && (streaming.text || streaming.reasoning) && (
        <div className="flex flex-col gap-2">
          {streaming.reasoning && <Reasoning text={streaming.reasoning} live={!streaming.text} />}
          {streaming.text && <Markdown text={streaming.text} />}
        </div>
      )}
      {busy && !(streaming && streaming.text) && (lastIsUser || streaming || pending) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          {streaming?.model ? <span className="font-mono">{streaming.model}</span> : 'Pensando…'}
        </div>
      )}
      {status === 'interrupted' && !lastError && (
        <Divider>
          <CircleSlash className="size-3" />a execução foi interrompida (o agent-host reiniciou)
        </Divider>
      )}
      {lastError && <ErrorBanner error={lastError} />}
      {paused && !busy && onContinue && <PausedCard reason={paused} onContinue={onContinue} />}
      <CompactionDialog target={opened} onOpenChange={(o) => !o && setOpened(null)} />
    </div>
  )
}
