import { useEffect, useState } from 'react'
import { Brain, Pencil, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Instruction } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { errorMessage, isUnknownMethod } from '@renderer/features/projects/store'
import { InstructionEditDialog } from './InstructionEditDialog'
import {
  MEMORY_HIGHLIGHT_MS,
  SCOPE_LABEL,
  draftFrom,
  memoryHighlighted,
  type InstructionDraft
} from './logic'

/** Card de `memory_saved` na timeline: Editar (instructions.save) e Desfazer (memory.undo). */
export function MemoryCard({
  instruction,
  created,
  at,
  undone,
  onEdited,
  onUndone
}: {
  instruction: Instruction
  created: boolean
  /** Quando o evento chegou (ms): destaque por 15 s. */
  at: number
  undone: boolean
  onEdited(i: Instruction): void
  onUndone(): void
}): React.JSX.Element {
  const [fresh, setFresh] = useState(() => memoryHighlighted(at, Date.now()))
  const [editing, setEditing] = useState<InstructionDraft | null>(null)
  const [undoing, setUndoing] = useState(false)

  useEffect(() => {
    if (!fresh) return
    const t = setTimeout(() => setFresh(false), Math.max(0, at + MEMORY_HIGHLIGHT_MS - Date.now()))
    return () => clearTimeout(t)
  }, [fresh, at])

  const undo = (): void => {
    setUndoing(true)
    call('memory.undo', { id: instruction.id })
      .then(onUndone)
      .catch((e: unknown) =>
        toast.error(
          isUnknownMethod(e)
            ? 'O agent-host ainda não suporta desfazer memórias.'
            : `Não foi possível desfazer: ${errorMessage(e)}`
        )
      )
      .finally(() => setUndoing(false))
  }

  return (
    <div
      data-memory-id={instruction.id}
      className={cn(
        'rounded-md border px-3 py-2 text-xs transition-colors duration-700',
        fresh && !undone ? 'border-primary/50 bg-primary/5' : 'bg-card',
        undone && 'opacity-60'
      )}
    >
      <div className="flex items-center gap-2">
        <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">
          {undone ? 'memória desfeita' : created ? 'memória salva' : 'memória atualizada'}
        </span>
        <span className={cn('min-w-0 flex-1 truncate font-medium', undone && 'line-through')}>
          {instruction.name}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {SCOPE_LABEL[instruction.scope]}
        </span>
        {!undone && (
          <>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 shrink-0"
              onClick={() => setEditing(draftFrom(instruction))}
            >
              <Pencil />
              Editar
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 shrink-0"
              disabled={undoing}
              onClick={undo}
            >
              <Undo2 />
              Desfazer
            </Button>
          </>
        )}
      </div>
      {!undone && (
        <p className="mt-1 line-clamp-4 pl-5.5 whitespace-pre-wrap text-muted-foreground">
          {instruction.body}
        </p>
      )}
      <InstructionEditDialog
        draft={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={onEdited}
      />
    </div>
  )
}
