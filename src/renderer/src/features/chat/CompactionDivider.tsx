import { Layers, SquarePen } from 'lucide-react'
import type { CompactionRecord } from '@shared/domain'
import { continueInNewChat } from '@renderer/features/projects/actions'
import { findAnyChat, useProjects } from '@renderer/features/projects/store'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { TRIGGER_LABEL, compactedCount } from './chatStore'

/** Divisor tracejado de uma compactação. `superseded` = resumo já absorvido por um posterior. */
export function CompactionDivider({
  record,
  superseded = false,
  onOpen
}: {
  /** null = summary sem registro conhecido. */
  record: CompactionRecord | null
  superseded?: boolean
  onOpen(): void
}): React.JSX.Element {
  const n = record ? compactedCount(record) : null
  // Divisor sempre está no chat aberto; subagente (somente leitura) não continua.
  const chatId = useUi((s) => s.chatId)
  const canContinue = useProjects((s) => {
    const c = findAnyChat(s, chatId)
    return !!c && !c.parentChatId
  })
  return (
    <div
      className={cn(
        'flex items-center gap-3 text-[11px]',
        superseded ? 'text-muted-foreground/50' : 'text-muted-foreground'
      )}
    >
      <div className="flex-1 border-t border-dashed border-current opacity-40" />
      <button
        type="button"
        onClick={onOpen}
        title={superseded ? 'Resumo antigo (absorvido por um resumo posterior)' : 'Ver resumo'}
        className="flex min-w-0 items-center gap-1.5 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Layers className="size-3 shrink-0" />
        <span className="truncate">
          resumo aplicado
          {record && (
            <>
              {' — '}
              {n} {n === 1 ? 'mensagem compactada' : 'mensagens compactadas'} ·{' '}
              <span className="font-mono">{record.summarizerModel}</span> ·{' '}
              {TRIGGER_LABEL[record.trigger]}
            </>
          )}
        </span>
      </button>
      {!superseded && canContinue && chatId && (
        <button
          type="button"
          onClick={() => void continueInNewChat(chatId)}
          title="Abre um chat novo que começa com este resumo"
          className="flex shrink-0 items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <SquarePen className="size-3" />
          Continuar em novo chat
        </button>
      )}
      <div className="flex-1 border-t border-dashed border-current opacity-40" />
    </div>
  )
}
