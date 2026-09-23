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
import { useUpdate } from './useUpdate'

export function UpdateBanner(): React.JSX.Element | null {
  const s = useUpdate()
  const [open, setOpen] = useState(false)
  if (s.phase === 'idle' || s.phase === 'checking') return null
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Versão {s.version}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
            {s.notes || 'Sem changelog.'}
          </pre>
          {s.phase === 'downloading' && <Progress value={s.percent} />}
          <DialogFooter>
            {s.phase === 'available' && (
              <Button onClick={() => void window.api.update.download()}>Baixar</Button>
            )}
            {s.phase === 'ready' && (
              <Button onClick={() => void window.api.update.install()}>
                Reiniciar e atualizar
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
