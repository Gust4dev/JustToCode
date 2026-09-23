import { useState } from 'react'
import { Download, ExternalLink, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { ConfirmDialog } from '@renderer/features/projects/ConfirmDialog'
import { componentsApi, refreshStatus, useComponents } from './componentsStore'
import { ErrorLine, LogView, Section } from './common'
import { isOutdated, ownershipLabel, ROUTER_DASHBOARD, statusText } from './format'
import { openExternal, useAction } from './hooks'

export function RouterTab(): React.JSX.Element {
  const status = useComponents((s) => s.statuses['9router'])
  const statusError = useComponents((s) => s.statusError)
  const { busy, run } = useAction()
  const [confirmStop, setConfirmStop] = useState(false)
  const api = componentsApi()

  const outdated = isOutdated(status?.version ?? null, status?.latestVersion ?? null)

  const stop = (force: boolean): void => {
    if (!api) return
    void run('stop', 'Parar o 9router', async () => {
      useComponents.getState().setStatus(await api.stop('9router', force ? { force } : undefined))
    })
  }

  const spinner = (key: string, icon: React.ReactNode): React.ReactNode =>
    busy === key ? <LoaderCircle className="animate-spin" /> : icon

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="9router"
        actions={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Atualizar status"
            title="Atualizar status"
            onClick={() => void refreshStatus()}
          >
            <RefreshCw />
          </Button>
        }
      >
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">Status</span>
          <span className="flex items-center gap-2">
            {statusText(status)}
            {status?.running && <Badge variant="outline">{ownershipLabel(status.ownership)}</Badge>}
            {status?.pid != null && (
              <span className="text-xs text-muted-foreground">pid {status.pid}</span>
            )}
          </span>
          <span className="text-muted-foreground">Instalada</span>
          <span>{status?.installed ? (status.version ?? 'versão desconhecida') : '—'}</span>
          <span className="text-muted-foreground">Última</span>
          <span className="flex items-center gap-2">
            {status?.latestVersion ?? '—'}
            {outdated && <Badge variant="secondary">atualização disponível</Badge>}
          </span>
          {status?.url && (
            <>
              <span className="text-muted-foreground">Endereço</span>
              <span className="font-mono text-xs leading-5">{status.url}</span>
            </>
          )}
        </div>
        {status?.message && <p className="mt-2 text-xs text-muted-foreground">{status.message}</p>}
        {statusError && (
          <div className="mt-2">
            <ErrorLine msg={`Status indisponível: ${statusError}`} />
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {!status?.installed ? (
            <Button
              size="sm"
              disabled={!api || busy !== null}
              onClick={() =>
                api &&
                void run(
                  'install',
                  'Instalar o 9router',
                  () => api.router.install(),
                  '9router instalado'
                ).then(() => refreshStatus())
              }
            >
              {spinner('install', <Download />)}
              Instalar
            </Button>
          ) : (
            <Button
              size="sm"
              variant={outdated ? 'default' : 'outline'}
              disabled={!api || busy !== null}
              onClick={() =>
                api &&
                void run(
                  'update',
                  'Atualizar o 9router',
                  () => api.router.update(),
                  '9router atualizado'
                ).then(() => refreshStatus())
              }
            >
              {spinner('update', <RefreshCw />)}
              Atualizar
            </Button>
          )}
          {status?.running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!api || busy !== null}
              onClick={() => (status.ownership === 'external' ? setConfirmStop(true) : stop(false))}
            >
              {spinner('stop', <Square />)}
              Parar
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!api || busy !== null || !status?.installed}
              onClick={() =>
                api &&
                void run('start', 'Iniciar o 9router', async () => {
                  useComponents.getState().setStatus(await api.start('9router'))
                })
              }
            >
              {spinner('start', <Play />)}
              Iniciar
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => openExternal(ROUTER_DASHBOARD)}>
            <ExternalLink />
            Abrir dashboard
          </Button>
        </div>
      </Section>

      <LogView id="9router" />

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Parar o 9router externo?"
        description="Este 9router não foi iniciado pelo JustToCode. Pará-lo encerra o processo que está escutando na porta 20128."
        confirmLabel="Parar mesmo assim"
        onConfirm={() => stop(true)}
      />
    </div>
  )
}
