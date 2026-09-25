import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { UpdateDialog } from './UpdateBanner'
import { useUpdate } from './useUpdate'

type Info = { version: string; isPackaged: boolean }

/** Configurações → Geral: versão atual + verificação manual (erros não são silenciosos). */
export function UpdateSection(): React.JSX.Element {
  const s = useUpdate()
  const [info, setInfo] = useState<Info | null>(null)
  const [devNotice, setDevNotice] = useState(false)
  const [callError, setCallError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.update
      .info()
      .then((i) => alive && setInfo(i))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const check = (): void => {
    if (info && !info.isPackaged) {
      setDevNotice(true)
      return
    }
    setCallError(null)
    window.api.update.check().catch((e: Error) => setCallError(e.message))
  }

  let status: React.ReactNode = null
  if (devNotice) status = 'Atualizações só funcionam no app instalado'
  else if (s.phase === 'checking') status = 'Verificando…'
  else if (s.phase === 'none') status = 'Você está na versão mais recente'
  else if (s.phase === 'error') status = <span className="text-destructive">Erro: {s.message}</span>
  else if (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready')
    status = (
      <>
        {s.phase === 'ready'
          ? `Versão ${s.version} pronta para instalar`
          : `Versão ${s.version} disponível`}{' '}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setOpen(true)}
        >
          {s.phase === 'available' ? 'Ver e baixar' : 'Ver detalhes'}
        </Button>
      </>
    )
  else if (callError) status = <span className="text-destructive">Erro: {callError}</span>

  return (
    <div className="grid gap-1.5 border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs">Versão atual {info?.version ?? '…'}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={s.phase === 'checking' || s.phase === 'downloading'}
          onClick={check}
        >
          Verificar atualizações
        </Button>
      </div>
      {status && <p className="text-[11px] text-muted-foreground">{status}</p>}
      {(s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready') && (
        <UpdateDialog state={s} open={open} onOpenChange={setOpen} />
      )}
    </div>
  )
}
