import { Download } from 'lucide-react'
import type { ComponentId } from '@shared/components'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { useComponents, type ComponentsTab } from './componentsStore'
import { aggregatePct, dotClass, statusDot, statusText } from './format'

function open(tab: ComponentsTab): void {
  useComponents.getState().setTab(tab)
  useUi.getState().setView('components')
}

function Indicator({ id, label }: { id: ComponentId; label: string }): React.JSX.Element {
  const s = useComponents((st) => st.statuses[id])
  const err = useComponents((st) => st.statusError)
  const title = `${label}: ${s ? statusText(s) : err ? `status indisponível (${err})` : 'status desconhecido'}`
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => open(id)}
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', dotClass(statusDot(s)))} />
      {label}
    </button>
  )
}

/** Indicadores da TopBar: 9router, llama e downloads em andamento. */
export function ComponentIndicators(): React.JSX.Element {
  const downloads = useComponents((s) => s.downloads)
  const list = Object.values(downloads)
  const active = list.filter((p) => !p.done && !p.error)
  const failed = list.filter((p) => p.error)
  const pct = aggregatePct(list)
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Indicator id="9router" label="9router" />
      <Indicator id="llama" label="llama" />
      {(active.length > 0 || failed.length > 0) && (
        <button
          type="button"
          onClick={() => open('models')}
          title={[
            ...active.map((p) => `${p.label}: baixando`),
            ...failed.map((p) => `${p.label}: ${p.error}`)
          ].join('\n')}
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs tabular-nums hover:bg-accent',
            failed.length && !active.length ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          <Download className="size-3.5" />
          {active.length ? (pct != null ? `${pct}%` : '…') : 'falhou'}
          {active.length > 1 && <span>({active.length})</span>}
        </button>
      )}
    </div>
  )
}
