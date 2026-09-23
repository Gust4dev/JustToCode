import { useEffect, useState } from 'react'
import { LoaderCircle, Shrink } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_CONFIG, type ContextState } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/features/projects/store'
import { cn } from '@renderer/lib/utils'
import { formatTokens, meterColor, type MeterColor } from './format'

const BAR_CLASS: Record<MeterColor, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500'
}

const fmt = (n: number): string => n.toLocaleString('pt-BR')

function compactErrorMessage(e: unknown): { level: 'info' | 'error'; text: string } {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'NOTHING_TO_COMPACT') return { level: 'info', text: 'Nada para compactar ainda.' }
  if (code === 'CHAT_BUSY')
    return { level: 'info', text: 'O chat está rodando; compacte quando ele terminar.' }
  if (code === 'UNKNOWN_METHOD')
    return { level: 'error', text: 'A compactação manual ainda não está disponível no agent-host.' }
  return { level: 'error', text: `Não foi possível compactar: ${errorMessage(e)}` }
}

export function ContextMeter({ chatId }: { chatId: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ chatId: string; ctx: ContextState | null } | null>(null)
  const [thresholdPct, setThresholdPct] = useState(DEFAULT_CONFIG.compactThresholdPct)
  const [compacting, setCompacting] = useState<string | null>(null)
  const ctx = loaded?.chatId === chatId ? loaded.ctx : null

  useEffect(() => {
    let alive = true
    call('context.get', { chatId })
      .then((c) => {
        if (alive) setLoaded({ chatId, ctx: c })
      })
      .catch(() => {
        // O engine pode ainda não estar registrado: mostra "— / ?" em silêncio.
        if (alive) setLoaded({ chatId, ctx: null })
      })
    return () => {
      alive = false
    }
  }, [chatId])

  useEffect(() => {
    let alive = true
    window.api.settings
      .get()
      .then((c) => {
        if (alive) setThresholdPct(c.compactThresholdPct)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [chatId])

  useEngineEvent((e) => {
    if (e.type === 'context_updated' && e.chatId === chatId) setLoaded({ chatId, ctx: e.context })
  })

  const compactNow = (): void => {
    if (compacting) return
    setCompacting(chatId)
    call('compaction.run', { chatId })
      .then(() => toast.success('Contexto compactado.'))
      .catch((e: unknown) => {
        const m = compactErrorMessage(e)
        if (m.level === 'info') toast.info(m.text)
        else toast.error(m.text)
      })
      .finally(() => setCompacting(null))
  }

  const used = ctx ? (ctx.reportedTokens ?? ctx.estTokens) : null
  const win = ctx?.effectiveWindow ?? null
  const pct = used !== null && win ? Math.min(1, used / win) : null
  const label = `${used === null ? '—' : formatTokens(used)} / ${win ? formatTokens(win) : '?'}`
  const threshold = Math.min(100, Math.max(0, thresholdPct))

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-chat-id={chatId}
            className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums"
          >
            <span>{label}</span>
            <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted">
              {pct !== null && (
                <div
                  className={cn('h-full rounded-full', BAR_CLASS[meterColor(pct)])}
                  style={{ width: `${Math.round(pct * 100)}%` }}
                />
              )}
              {win !== null && (
                <div
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-foreground/50"
                  style={{ left: `${threshold}%` }}
                />
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {!ctx ? (
            <p>Contexto indisponível</p>
          ) : (
            <div className="space-y-0.5">
              <p>Estimado: {fmt(ctx.estTokens)} tokens</p>
              <p>
                Reportado: {ctx.reportedTokens === null ? '—' : `${fmt(ctx.reportedTokens)} tokens`}
              </p>
              {win ? (
                <>
                  <p>Janela: {fmt(win)} tokens</p>
                  {ctx.limitingModel && <p>limitado por {ctx.limitingModel}</p>}
                  <p>
                    Compacta ao passar de {threshold}% (~{formatTokens((win * threshold) / 100)})
                  </p>
                </>
              ) : (
                <p>Janela desconhecida: defina a combo</p>
              )}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label="Compactar agora"
            disabled={compacting === chatId}
            onClick={compactNow}
          >
            {compacting === chatId ? <LoaderCircle className="animate-spin" /> : <Shrink />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Compactar agora</TooltipContent>
      </Tooltip>
    </div>
  )
}
