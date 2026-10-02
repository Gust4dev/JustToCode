import { lazy, Suspense, useState } from 'react'
import { ContextMenu } from 'radix-ui'
import { toast } from 'sonner'
import { Check, FileDiff, PanelRightOpen, Undo2 } from 'lucide-react'
import { call } from '@renderer/lib/host'
import { errorMessage } from '@renderer/features/projects/store'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import type { ConflictTarget } from './ConflictDialog'
import { interpretRevert } from './origins'
import { chatRevertTargets, revertAllSummary, type RevertAllTally } from './revertAll'
import { useChangedFiles } from './useChangedFiles'

const ConflictDialog = lazy(() =>
  import('./ConflictDialog').then((m) => ({ default: m.ConflictDialog }))
)

const ITEM =
  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground'

/**
 * Barra acima do compositor quando o painel de alterações está recolhido:
 * "N arquivos alterados" + aceitar tudo; clique reabre o painel, botão direito abre o menu.
 */
export function ChangesBar({
  projectId,
  chatId,
  onOpenPanel
}: {
  projectId: string
  chatId: string
  onOpenPanel(): void
}): React.JSX.Element | null {
  const { files, refresh } = useChangedFiles(projectId, null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [conflicts, setConflicts] = useState<ConflictTarget[]>([])

  const count = files?.length ?? 0
  const targets = files ? chatRevertTargets(files, chatId) : []

  const acceptAll = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('changes.accept', { projectId })
    } catch (e) {
      toast.error(`Não foi possível aceitar: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const revertAll = async (): Promise<void> => {
    setConfirming(false)
    setBusy(true)
    const tally: RevertAllTally = { reverted: 0, conflicts: 0, failed: 0 }
    const found: ConflictTarget[] = []
    for (const path of targets) {
      try {
        const r = interpretRevert(await call('changes.revert', { projectId, chatId, path }))
        if (r.kind === 'reverted') tally.reverted++
        else {
          tally.conflicts++
          found.push(
            r.kind === 'conflict'
              ? { path, chatId, conflict: r.conflict, message: r.message }
              : { path, chatId, conflict: null, message: r.message }
          )
        }
      } catch {
        tally.failed++
      }
    }
    setBusy(false)
    const summary = revertAllSummary(tally)
    toast[summary.level](summary.text)
    if (found.length > 0) setConflicts((cur) => [...cur, ...found])
    await refresh()
  }

  const nextConflict = (): void => {
    setConflicts((cur) => cur.slice(1))
    void refresh()
  }

  const conflict = conflicts[0] ?? null
  const dialogs = (
    <>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recusar tudo deste chat?</DialogTitle>
            <DialogDescription>
              Desfaz as alterações deste chat em{' '}
              {targets.length === 1 ? '1 arquivo' : `${targets.length} arquivos`}. Arquivos que
              mudaram depois abrem a resolução de conflito.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void revertAll()}>
              Recusar tudo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {conflict && (
        <Suspense fallback={null}>
          <ConflictDialog
            key={`${conflict.chatId}|${conflict.path}`}
            projectId={projectId}
            target={conflict}
            onClose={nextConflict}
            onResolved={nextConflict}
          />
        </Suspense>
      )}
    </>
  )

  if (count === 0) return dialogs

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            role="button"
            tabIndex={0}
            title="Abrir painel de alterações (botão direito: mais opções)"
            className="mb-1.5 flex cursor-pointer items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onOpenPanel}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpenPanel()
              }
            }}
          >
            <FileDiff className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {count === 1 ? '1 arquivo alterado' : `${count} arquivos alterados`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Aceitar tudo"
              title="Aceitar tudo"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void acceptAll()
              }}
            >
              <Check />
            </Button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[12rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <ContextMenu.Item
              className={ITEM}
              disabled={busy || targets.length === 0}
              onSelect={() => setConfirming(true)}
            >
              <Undo2 />
              Recusar tudo deste chat
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} onSelect={onOpenPanel}>
              <PanelRightOpen />
              Abrir painel
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {dialogs}
    </>
  )
}
