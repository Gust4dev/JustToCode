import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ChatMessage, CompactionRecord, StoredMessage } from '@shared/domain'
import { call } from '@renderer/lib/host'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { errorMessage } from '@renderer/features/projects/store'
import { formatTokens } from '@renderer/features/context/format'
import { TRIGGER_LABEL } from './chatStore'
import { Markdown } from './Markdown'

export type CompactionTarget =
  | { kind: 'record'; id: string }
  /** Summary sem registro conhecido: mostra só o texto. */
  | { kind: 'summary'; message: StoredMessage }

const SUMMARY_PREFIX = /^\[Summary of the earlier conversation[^\]]*\]\s*/

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | {
      state: 'ok'
      record: CompactionRecord | null
      summary: string
      originals: StoredMessage[] | null
    }

function plainText(m: ChatMessage): string {
  const c = m.content
  if (c === null) return ''
  if (typeof c === 'string') return c
  return c.map((p) => (p.type === 'text' ? p.text : '[imagem]')).join('\n')
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  system: 'sistema',
  user: 'usuário',
  assistant: 'assistente',
  tool: 'ferramenta'
}

const MAX_TOOL_CHARS = 1500

function Original({ m }: { m: StoredMessage }): React.JSX.Element {
  const msg = m.message
  const calls = msg.role === 'assistant' ? (msg.tool_calls ?? []) : []
  const text = plainText(msg)
  const long = msg.role === 'tool' && text.length > MAX_TOOL_CHARS
  return (
    <div className="grid gap-1 border-l-2 pl-3">
      <div className="text-[11px] text-muted-foreground">
        #{m.seq} · {ROLE_LABEL[msg.role]}
        {m.modelUsed && <span className="font-mono"> · {m.modelUsed}</span>}
      </div>
      {text && (
        <div className="text-xs break-words whitespace-pre-wrap">
          {long ? `${text.slice(0, MAX_TOOL_CHARS)}\n…[cortado]` : text}
        </div>
      )}
      {calls.length > 0 && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {calls.map((c) => c.function.name).join(', ')}
        </div>
      )}
    </div>
  )
}

export function CompactionDialog({
  target,
  onOpenChange
}: {
  target: CompactionTarget | null
  onOpenChange(open: boolean): void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ id: string; data: Loaded } | null>(null)
  const recordId = target?.kind === 'record' ? target.id : null

  useEffect(() => {
    if (!recordId) return
    let alive = true
    call('compaction.get', { id: recordId })
      .then((r) => {
        if (!alive) return
        setLoaded({
          id: recordId,
          data: { state: 'ok', record: r.record, summary: r.summary, originals: r.originals }
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        const unknown = (e as { code?: unknown } | null)?.code === 'UNKNOWN_METHOD'
        setLoaded({
          id: recordId,
          data: {
            state: 'error',
            message: unknown
              ? 'o agent-host ainda não oferece a leitura de compactações.'
              : errorMessage(e)
          }
        })
      })
    return () => {
      alive = false
    }
  }, [recordId])

  const data: Loaded =
    target?.kind === 'summary'
      ? {
          state: 'ok',
          record: null,
          summary: plainText(target.message.message).replace(SUMMARY_PREFIX, ''),
          originals: null
        }
      : loaded && loaded.id === recordId
        ? loaded.data
        : { state: 'loading' }
  const record = data.state === 'ok' ? data.record : null

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Resumo aplicado</DialogTitle>
          <DialogDescription className="text-xs">
            {record ? (
              <>
                <span className="font-mono">{record.summarizerModel}</span> ·{' '}
                {TRIGGER_LABEL[record.trigger]} · {formatTokens(record.tokensBefore)} →{' '}
                {formatTokens(record.tokensAfter)} tokens ·{' '}
                {new Date(record.createdAt).toLocaleString('pt-BR')}
              </>
            ) : (
              'Resumo estruturado da conversa anterior.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          {data.state === 'loading' && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {data.state === 'error' && (
            <p className="text-sm text-destructive">Não foi possível abrir: {data.message}</p>
          )}
          {data.state === 'ok' && (
            <div className="grid gap-4">
              <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
                <Markdown text={data.summary} />
              </div>
              {data.originals && data.originals.length > 0 && (
                <details className="group text-xs">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-muted-foreground select-none hover:text-foreground">
                    <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                    {data.originals.length} mensagens originais
                  </summary>
                  <div className="mt-2 grid gap-3">
                    {data.originals.map((m) => (
                      <Original key={m.id} m={m} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
