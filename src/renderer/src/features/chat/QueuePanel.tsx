import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, Pause, Pencil, Play, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { QueueState, QueuedMessage } from '@shared/domain'
import type { HostMethod, HostParams } from '@shared/api'
import { call } from '@renderer/lib/host'
import { Button } from '@renderer/components/ui/button'
import { errorMessage } from '@renderer/features/projects/store'
import { queueLabel, queuePaused } from './runControls'

type QueueMethod = Extract<HostMethod, 'queue.remove' | 'queue.edit' | 'queue.resume'>

function QueueItem({
  item,
  onEdit,
  onRemove
}: {
  item: QueuedMessage
  onEdit(text: string): Promise<boolean>
  onRemove(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (draft === null) return
    const text = draft.trim()
    if (!text || text === item.text) {
      setDraft(null)
      return
    }
    if (await onEdit(text)) setDraft(null)
  }

  if (draft !== null)
    return (
      <li className="flex items-start gap-1 px-2 py-1">
        <textarea
          autoFocus
          rows={2}
          value={draft}
          aria-label="Editar mensagem da fila"
          className="min-w-0 flex-1 resize-none rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
            }
          }}
        />
        <Button variant="ghost" size="icon-xs" aria-label="Salvar" onClick={() => void save()}>
          <Check />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Cancelar" onClick={() => setDraft(null)}>
          <X />
        </Button>
      </li>
    )

  return (
    <li className="group flex items-center gap-1 px-2 py-1">
      <span className="min-w-0 flex-1 truncate text-xs" title={item.text}>
        {item.text || '(só anexos)'}
      </span>
      {item.attachments.length > 0 && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          +{item.attachments.length} anexo{item.attachments.length > 1 ? 's' : ''}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Editar"
        title="Editar"
        onClick={() => setDraft(item.text)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Remover"
        title="Remover"
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </li>
  )
}

/** Faixa "N na fila" acima do composer + banner de fila pausada. */
export function QueuePanel({
  queue,
  onQueue
}: {
  queue: QueueState | null
  onQueue(q: QueueState): void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const label = queueLabel(queue)
  const paused = queuePaused(queue)
  if (!queue || (!label && !paused)) return null

  const run = async <M extends QueueMethod>(
    method: M,
    params: HostParams<M>,
    fail: string
  ): Promise<boolean> => {
    try {
      onQueue(await call(method, params))
      return true
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code
      toast.error(
        code === 'UNKNOWN_METHOD'
          ? `${fail}: o agent-host ainda não suporta a fila.`
          : `${fail}: ${errorMessage(e)}`
      )
      return false
    }
  }

  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border bg-muted/40 text-xs">
      {paused && (
        <div
          role="status"
          className="flex items-center gap-2 border-b px-2 py-1 text-amber-700 last:border-b-0 dark:text-amber-400"
        >
          <Pause className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Fila pausada{queue.pauseReason ? `: ${queue.pauseReason}` : ''}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="text-foreground"
            onClick={() =>
              void run('queue.resume', { chatId: queue.chatId }, 'Não foi possível retomar')
            }
          >
            <Play />
            Retomar
          </Button>
        </div>
      )}
      {label && (
        <>
          <button
            type="button"
            aria-expanded={open}
            className="flex w-full items-center gap-1 px-2 py-1 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((o) => !o)}
          >
            {label}
            {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          {open && (
            <ul className="max-h-40 overflow-y-auto border-t py-0.5">
              {queue.items.map((item) => (
                <QueueItem
                  key={item.id}
                  item={item}
                  onEdit={(text) =>
                    run('queue.edit', { id: item.id, text }, 'Não foi possível editar')
                  }
                  onRemove={() =>
                    void run('queue.remove', { id: item.id }, 'Não foi possível remover')
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
