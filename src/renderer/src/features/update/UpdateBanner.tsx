import { useState } from 'react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@renderer/components/ui/dialog'
import { Progress } from '@renderer/components/ui/progress'
import { Markdown } from '@renderer/features/chat/Markdown'
import type { UpdateState } from '../../../../main/updater/state'
import { useUpdate } from './useUpdate'

type WithVersion = Extract<UpdateState, { version: string }>

/** Changelog + baixar/instalar. Compartilhado pelo banner e por Configurações. */
export function UpdateDialog({
  state: s,
  open,
  onOpenChange
}: {
  state: WithVersion
  open: boolean
  onOpenChange(open: boolean): void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Versão {s.version}</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 overflow-auto">
          {s.notes ? (
            <Markdown text={s.notes} className="text-xs" />
          ) : (
            <p className="text-xs text-muted-foreground">Sem changelog.</p>
          )}
        </div>
        {s.phase === 'downloading' && <Progress value={s.percent} />}
        <DialogFooter>
          {s.phase === 'available' && (
            <Button type="button" onClick={() => void window.api.update.download()}>
              Baixar
            </Button>
          )}
          {s.phase === 'ready' && (
            <Button type="button" onClick={() => void window.api.update.install()}>
              Reiniciar e atualizar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function UpdateBanner(): React.JSX.Element | null {
  const s = useUpdate()
  const [open, setOpen] = useState(false)
  if (s.phase === 'idle' || s.phase === 'checking' || s.phase === 'none') return null
  if (s.phase === 'error')
    return (
      <Badge variant="destructive" title={s.message}>
        Falha ao atualizar
      </Badge>
    )

  return (
    <>
      <Badge asChild className="cursor-pointer">
        <button type="button" onClick={() => setOpen(true)}>
          {s.phase === 'ready' ? `v${s.version} pronta` : `v${s.version} disponível`}
        </button>
      </Badge>
      <UpdateDialog state={s} open={open} onOpenChange={setOpen} />
    </>
  )
}
