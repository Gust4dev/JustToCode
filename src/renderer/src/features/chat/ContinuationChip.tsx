import { useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import type { StoredMessage } from '@shared/domain'
import { findAnyChat, useProjects } from '@renderer/features/projects/store'
import { useUi } from '@renderer/stores/ui'
import { CompactionDialog, type CompactionTarget } from './CompactionDialog'

/** Chip de chat continuado: "continuação de <título> · ver resumo". */
export function ContinuationChip({
  fromChatId,
  messages
}: {
  fromChatId: string
  messages: StoredMessage[]
}): React.JSX.Element {
  const origin = useProjects((s) => findAnyChat(s, fromChatId))
  const summary = messages.find((m) => m.kind === 'summary') ?? null
  const [opened, setOpened] = useState<CompactionTarget | null>(null)
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b px-4 py-1 text-[11px] text-muted-foreground">
      <CornerDownRight className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        continuação de{' '}
        {origin ? (
          <button
            type="button"
            className="font-medium text-foreground underline-offset-2 hover:underline"
            onClick={() => useUi.getState().selectChat(fromChatId)}
          >
            {origin.title}
          </button>
        ) : (
          <span className="italic">chat removido</span>
        )}
      </span>
      {summary && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setOpened({ kind: 'summary', message: summary })}
          >
            ver resumo
          </button>
        </>
      )}
      <CompactionDialog target={opened} onOpenChange={(o) => !o && setOpened(null)} />
    </div>
  )
}
