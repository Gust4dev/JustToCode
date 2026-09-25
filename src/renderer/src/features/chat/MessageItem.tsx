import { memo } from 'react'
import { Brain, Check, ChevronRight, Image as ImageIcon } from 'lucide-react'
import type { Approval, ContentPart, StoredMessage } from '@shared/domain'
import { cn } from '@renderer/lib/utils'
import { PayloadButton } from '@renderer/features/payload/PayloadButton'
import { CopyTextButton } from './CopyButton'
import { formatBytes, sentPreviews } from './attachments'
import type { LiveToolCall } from './chatStore'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'

export interface ReceiptItem {
  name: string
  bytes: number
  preview: string | null
}

const textOf = (c: string | ContentPart[] | null): string =>
  c === null
    ? ''
    : typeof c === 'string'
      ? c
      : c
          .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join('\n')

/** Mensagem do usuário. `confirmed` = veio do host (foi gravada e vai no request). */
export function UserBubble({
  text,
  receipts,
  confirmed
}: {
  text: string
  receipts: ReceiptItem[]
  confirmed: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {receipts.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {receipts.map((r, i) => (
            <figure key={i} className="flex flex-col items-end gap-1">
              {r.preview ? (
                <img
                  src={r.preview}
                  alt={r.name}
                  title={r.name}
                  className="max-h-32 max-w-48 rounded-md border object-cover"
                />
              ) : (
                <div
                  title={r.name}
                  className="flex size-16 items-center justify-center rounded-md border bg-muted text-muted-foreground"
                >
                  <ImageIcon className="size-5" />
                </div>
              )}
              <figcaption
                className={cn(
                  'flex items-center gap-1 text-[11px] text-muted-foreground',
                  !confirmed && 'opacity-70'
                )}
              >
                {confirmed ? 'imagem enviada' : 'enviando'} · {formatBytes(r.bytes)}
                {confirmed && <Check className="size-3 text-emerald-600 dark:text-emerald-400" />}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {text && (
        <div
          className={cn(
            'max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words',
            !confirmed && 'opacity-70'
          )}
        >
          {text}
        </div>
      )}
    </div>
  )
}

export function Reasoning({ text, live }: { text: string; live?: boolean }): React.JSX.Element {
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 select-none hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        <Brain className="size-3.5" />
        {live ? 'Raciocinando…' : 'Raciocínio'}
      </summary>
      <div className="mt-1.5 ml-1.5 border-l-2 pl-3 whitespace-pre-wrap">{text}</div>
    </details>
  )
}

export const MessageItem = memo(function MessageItem({
  message,
  toolCalls,
  approvals
}: {
  message: StoredMessage
  /** Tool calls desta mensagem (já filtradas por messageId). */
  toolCalls: LiveToolCall[]
  /** Aprovações por toolCallId. */
  approvals: Record<string, Approval>
}): React.JSX.Element | null {
  const m = message.message
  // Resumos de compactação aparecem como divisor (CompactionDivider), não como mensagem.
  if (message.kind === 'summary') return null
  if (m.role === 'user') {
    const previews = sentPreviews.get(message.id) ?? []
    const receipts = message.attachments.map((a, i) => ({
      name: a.name,
      bytes: a.bytes,
      preview: previews[i] ?? null
    }))
    return <UserBubble text={textOf(m.content)} receipts={receipts} confirmed />
  }
  if (m.role !== 'assistant') return null

  // Ordem das chamadas como o modelo pediu; o que não casar vai no fim.
  const order = new Map((m.tool_calls ?? []).map((t, i) => [t.id, i]))
  const calls = [...toolCalls].sort(
    (a, b) => (order.get(a.modelCallId) ?? 1e9) - (order.get(b.modelCallId) ?? 1e9)
  )
  const text = textOf(m.content)

  return (
    <div className="group/msg flex flex-col gap-2">
      {m.reasoning && <Reasoning text={m.reasoning} />}
      {text && <Markdown text={text} />}
      {calls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {calls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} approval={approvals[tc.id]} />
          ))}
        </div>
      )}
      {(message.modelUsed || message.requestId || text) && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60 transition-colors group-hover/msg:text-muted-foreground">
          {message.modelUsed && <span className="font-mono">{message.modelUsed}</span>}
          {text && <CopyTextButton text={text} />}
          {message.requestId && <PayloadButton requestId={message.requestId} />}
        </div>
      )}
    </div>
  )
})
