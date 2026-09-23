import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Info, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ComponentId, MemoryEstimate } from '@shared/components'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { componentsApi, useComponents } from './componentsStore'
import { formatMB, isNotImplemented, levelClass, levelLabel } from './format'

export function Unavailable({ what }: { what: string }): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Info className="size-3.5" />
      {what}: ainda não disponível nesta versão.
    </p>
  )
}

export function ErrorLine({ msg }: { msg: string }): React.JSX.Element {
  return <p className="text-xs text-destructive">{msg}</p>
}

export function Section({
  title,
  actions,
  children,
  className
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('rounded-lg border p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** Badge verde/amarelo/vermelho da estimativa de memória. */
export function LevelBadge({ est }: { est: MemoryEstimate }): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className={levelClass(est.level)}
      title={`pesos ${formatMB(est.weightsMB)} + KV ${formatMB(est.kvMB)} + overhead ${formatMB(est.overheadMB)}`}
    >
      {formatMB(est.totalMB)} · {levelLabel(est.level)}
    </Badge>
  )
}

/** Log ao vivo de um componente: carrega o histórico do main e segue os eventos, com auto-scroll. */
export function LogView({ id }: { id: ComponentId }): React.JSX.Element {
  const lines = useComponents((s) => s.logs[id])
  const boxRef = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    const api = componentsApi()
    if (!api) return
    let alive = true
    api
      .logs(id)
      .then((l) => alive && useComponents.getState().setLogs(id, l))
      .catch((e: unknown) => alive && setUnavailable(isNotImplemented(e)))
    return () => {
      alive = false
    }
  }, [id])

  useLayoutEffect(() => {
    const el = boxRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const copy = (): void => {
    navigator.clipboard
      .writeText(lines.join('\n'))
      .then(() => toast.success('Log copiado'))
      .catch(() => toast.error('Não foi possível copiar o log'))
  }

  return (
    <Section
      title="Log"
      actions={
        <>
          <span className="text-xs text-muted-foreground">{lines.length} linhas</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copiar log"
            title="Copiar log"
            disabled={!lines.length}
            onClick={copy}
          >
            <Copy />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Limpar a visualização do log"
            title="Limpar a visualização"
            disabled={!lines.length}
            onClick={() => useComponents.getState().clearLogs(id)}
          >
            <Trash2 />
          </Button>
        </>
      }
    >
      {unavailable && !lines.length ? (
        <Unavailable what="Log" />
      ) : (
        <pre
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          className="h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap"
        >
          {lines.length ? (
            lines.join('\n')
          ) : (
            <span className="text-muted-foreground">sem saída</span>
          )}
        </pre>
      )}
    </Section>
  )
}
