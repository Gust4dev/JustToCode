import { Fragment, useMemo, useState } from 'react'
import {
  ArrowRight,
  CircleSlash,
  Layers,
  LoaderCircle,
  Settings,
  TriangleAlert
} from 'lucide-react'
import type { Approval } from '@shared/domain'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { openSettings } from '@renderer/stores/settingsDialog'
import { buildTimeline, type ChatViewState, type LiveToolCall } from './chatStore'
import { CompactionDialog, type CompactionTarget } from './CompactionDialog'
import { CompactionDivider } from './CompactionDivider'
import { Markdown } from './Markdown'
import { MessageItem, Reasoning, UserBubble, type ReceiptItem } from './MessageItem'
import { ToolCallCard } from './ToolCallCard'

const NO_CALLS: LiveToolCall[] = []

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

function ModelSwitch({ from, to }: { from: string | null; to: string }): React.JSX.Element {
  return (
    <Divider>
      modelo mudou:
      <span className="font-mono">{from ?? '—'}</span>
      <ArrowRight className="size-3" />
      <span className="font-mono">{to}</span>
    </Divider>
  )
}

function ErrorBanner({ error }: { error: { message: string; code?: string } }): React.JSX.Element {
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
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{error.message}</p>
      {error.code === 'AUTH' && (
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
  pending
}: {
  state: ChatViewState
  approvals: Record<string, Approval>
  pending: PendingMessage | null
}): React.JSX.Element {
  const { messages, toolCalls, streaming, modelSwitches, lastError, status, compactions } = state

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
          <ModelSwitch key={`s0-${i}`} from={s.from} to={s.to} />
        ))}
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
            {modelSwitches
              .filter((s) => s.afterSeq === m.seq)
              .map((s, i) => (
                <ModelSwitch key={`s${m.seq}-${i}`} from={s.from} to={s.to} />
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
      <CompactionDialog target={opened} onOpenChange={(o) => !o && setOpened(null)} />
    </div>
  )
}
