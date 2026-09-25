import { useEffect, useState } from 'react'
import { ChevronDown, ScrollText, TriangleAlert } from 'lucide-react'
import type { ActiveInstructions } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { isUnknownMethod } from '@renderer/features/projects/store'
import { formatTokens } from '@renderer/features/context/format'
import { KIND_LABEL, SCOPE_LABEL, activeLabel, activeSummary } from './logic'

const INCLUDED_LABEL = { content: 'no prompt', listed: 'listada', dropped: 'cortada' } as const

/** "N instruções ativas ▾" na barra do chat; some se o host não tem `instructions.active`. */
export function ActiveInstructionsIndicator({
  chatId
}: {
  chatId: string
}): React.JSX.Element | null {
  const [data, setData] = useState<{ chatId: string; active: ActiveInstructions | null } | null>(
    null
  )
  const [unsupported, setUnsupported] = useState(false)
  const [tick, setTick] = useState(0)
  const active = data?.chatId === chatId ? data.active : null

  useEffect(() => {
    let alive = true
    call('instructions.active', { chatId })
      .then((a) => alive && setData({ chatId, active: a }))
      .catch((e: unknown) => {
        if (!alive) return
        if (isUnknownMethod(e)) setUnsupported(true)
        else setData({ chatId, active: null })
      })
    return () => {
      alive = false
    }
  }, [chatId, tick])

  // Arquivos tocados, @nome e memórias mudam o que está ativo: recarrega ao fim de cada turno.
  useEngineEvent((e) => {
    if (!('chatId' in e) || e.chatId !== chatId) return
    if (e.type === 'turn_finished' || e.type === 'turn_paused' || e.type === 'memory_saved')
      setTick((t) => t + 1)
  })

  if (unsupported) return null
  const sum = activeSummary(active)

  return (
    <Popover onOpenChange={(o) => o && setTick((t) => t + 1)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            'gap-1 text-xs font-normal text-muted-foreground',
            sum.overBudget && 'text-amber-600 dark:text-amber-400'
          )}
          title="Instruções que entram neste chat"
        >
          {sum.overBudget ? <TriangleAlert /> : <ScrollText />}
          {activeLabel(sum.count)}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-xs font-medium">{activeLabel(sum.count)}</p>
          {active && (
            <p className="text-[11px] text-muted-foreground">
              Sempre ativas: {formatTokens(active.alwaysTokens)} de{' '}
              {formatTokens(active.alwaysBudget)} tokens
            </p>
          )}
          {sum.overBudget && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              Orçamento das instruções sempre ativas estourado: {sum.dropped}{' '}
              {sum.dropped === 1 ? 'item foi cortado' : 'itens foram cortados'}.
            </p>
          )}
        </div>
        {!active || active.items.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">Nenhuma instrução ativa.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {active.items.map((i) => (
              <li
                key={i.id}
                className={cn(
                  'flex items-start gap-2 px-3 py-1.5 text-xs',
                  i.included === 'dropped' && 'text-destructive'
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono font-medium" title={i.name}>
                    {i.name}
                  </p>
                  <p
                    className={cn(
                      'truncate text-[11px]',
                      i.included === 'dropped' ? 'text-destructive/80' : 'text-muted-foreground'
                    )}
                    title={i.reason}
                  >
                    {KIND_LABEL[i.kind]} · {SCOPE_LABEL[i.scope]} · {i.reason}
                  </p>
                </div>
                <div className="shrink-0 text-right text-[11px] tabular-nums">
                  <p>{formatTokens(i.tokens)}</p>
                  <p
                    className={cn(
                      i.included === 'dropped' ? 'text-destructive/80' : 'text-muted-foreground'
                    )}
                  >
                    {INCLUDED_LABEL[i.included]}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t px-2 py-1.5">
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start text-xs font-normal"
            onClick={() => useUi.getState().setView('instructions')}
          >
            Gerenciar instruções
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
