import { useEffect, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { onAgentClient } from '@renderer/lib/agent'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { useProjects } from '@renderer/features/projects/store'
import { ApprovalsInbox } from '@renderer/features/approvals/ApprovalsInbox'
import { UpdateBanner } from '@renderer/features/update/UpdateBanner'
import { ComponentIndicators } from '@renderer/features/components/ComponentIndicators'

/** Pinga o agent-host a cada cliente novo (carga e restart) e devolve o texto de status. */
function useHostStatus(): { text: string; ok: boolean | null } {
  const [status, setStatus] = useState<{ text: string; ok: boolean | null }>({
    text: 'conectando…',
    ok: null
  })
  useEffect(
    () =>
      onAgentClient(async (a) => {
        try {
          const r = await a.call<{ pid: number }>('host.ping')
          const info = await a.call<{ userVersion: number }>('host.dbInfo')
          setStatus({ text: `agent-host ok (pid ${r.pid}) · db v${info.userVersion}`, ok: true })
        } catch (e) {
          setStatus({ text: `erro: ${(e as Error).message}`, ok: false })
        }
      }),
    []
  )
  return status
}

export function TopBar({
  diffOpen,
  onToggleDiff
}: {
  diffOpen: boolean
  onToggleDiff(): void
}): React.JSX.Element {
  const projectId = useUi((s) => s.projectId)
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const host = useHostStatus()
  const view = useUi((s) => s.view)

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-sm">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-[50%] shrink-0 truncate font-medium">
          {project?.name ?? 'JustToCode'}
        </span>
        {project && (
          <span className="truncate text-xs text-muted-foreground" title={project.path}>
            {project.path}
          </span>
        )}
      </div>
      <span
        className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        title="Status do agent-host"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full bg-muted-foreground/50',
            host.ok === true && 'bg-emerald-500',
            host.ok === false && 'bg-destructive'
          )}
        />
        {host.text}
      </span>
      <ComponentIndicators />
      <ApprovalsInbox />
      <UpdateBanner />
      {project && view === 'chat' && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={diffOpen ? 'Recolher painel de alterações' : 'Mostrar painel de alterações'}
          title={diffOpen ? 'Recolher painel de alterações' : 'Mostrar painel de alterações'}
          onClick={onToggleDiff}
        >
          {diffOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </Button>
      )}
    </header>
  )
}
