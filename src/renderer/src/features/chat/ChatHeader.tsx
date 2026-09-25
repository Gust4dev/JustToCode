import { useEffect, useId, useState } from 'react'
import { Ellipsis, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_CONFIG, type Chat } from '@shared/domain'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, useProjects } from '@renderer/features/projects/store'
import { formatTokens, meterColor } from '@renderer/features/context/format'
import { cn } from '@renderer/lib/utils'
import type { BudgetState, ReasoningStatus } from './chatStore'
import { ActiveInstructionsIndicator } from '@renderer/features/instructions/ActiveInstructionsIndicator'
import { ChatSettingsPanel } from '@renderer/features/instructions/ChatSettingsPanel'
import { reasoningChip } from '@renderer/features/instructions/logic'
import {
  budgetFraction,
  formatTokenInput,
  isContinuous,
  parseTokenInput,
  toggleContinuous
} from './runControls'

const BAR_CLASS = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' } as const

const isUnknownMethod = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === 'UNKNOWN_METHOD'

function failToast(what: string, e: unknown): void {
  toast.error(
    isUnknownMethod(e)
      ? `${what}: o agent-host ainda não suporta isso.`
      : `${what}: ${errorMessage(e)}`
  )
}

/** Padrão de iterações das configurações (para desligar o "Contínuo"). */
function useDefaultMaxIterations(): number {
  const [n, setN] = useState(DEFAULT_CONFIG.defaultMaxIterations)
  useEffect(() => {
    let alive = true
    window.api.settings
      .get()
      .then((c) => {
        if (alive && typeof c.defaultMaxIterations === 'number') setN(c.defaultMaxIterations)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return n
}

function BudgetField({ chat }: { chat: Chat }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const id = useId()
  const value = draft ?? formatTokenInput(chat.tokenBudget)

  const commit = (): void => {
    if (draft === null) return
    const parsed = parseTokenInput(draft)
    setDraft(null)
    if (parsed === undefined) {
      toast.error('Orçamento inválido: use um número de tokens (ex.: 200k).')
      return
    }
    if (parsed === chat.tokenBudget) return
    useProjects
      .getState()
      .updateChat(chat.id, { tokenBudget: parsed })
      .catch((e: unknown) => failToast('Não foi possível salvar o orçamento', e))
  }

  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Orçamento
      </label>
      <Input
        id={id}
        value={value}
        placeholder="sem"
        inputMode="numeric"
        title="Tokens por turno (ex.: 200k). Vazio = sem orçamento."
        className="h-6 w-20 px-2 text-xs md:text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(null)
          }
        }}
      />
    </div>
  )
}

function BudgetBar({ budget }: { budget: BudgetState }): React.JSX.Element {
  const pct = budgetFraction(budget)
  const iter = `${budget.iterations}${budget.maxIterations !== null ? `/${budget.maxIterations}` : ''} iterações`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
          <span>
            {formatTokens(budget.used)}
            {budget.budget !== null && ` / ${formatTokens(budget.budget)}`}
          </span>
          {pct !== null && (
            <div
              role="progressbar"
              aria-label="Uso do orçamento"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct * 100)}
              className="h-1 w-16 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn('h-full rounded-full', BAR_CLASS[meterColor(pct)])}
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          {budget.used.toLocaleString('pt-BR')} tokens neste turno
          {budget.budget !== null && ` de ${budget.budget.toLocaleString('pt-BR')}`}
        </p>
        <p>{iter}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function ReasoningChip({ status }: { status: ReasoningStatus | null }): React.JSX.Element | null {
  const chip = reasoningChip(status)
  if (!chip) return null
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-2 py-px text-[11px]',
        chip.confirmed
          ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
          : 'border-amber-500/40 text-amber-700 dark:text-amber-400'
      )}
      title={
        chip.confirmed
          ? 'O provedor devolveu raciocínio no último request.'
          : 'Não veio sinal de raciocínio no último request: o provedor pode ter ignorado o ajuste.'
      }
    >
      {chip.text}
    </span>
  )
}

export function ChatHeader({
  chat,
  budget,
  reasoning
}: {
  chat: Chat
  budget: BudgetState | null
  reasoning: ReasoningStatus | null
}): React.JSX.Element {
  const defaultMax = useDefaultMaxIterations()
  const [titling, setTitling] = useState(false)
  const continuous = isContinuous(chat.maxIterations)

  const setContinuous = (): void => {
    useProjects
      .getState()
      .updateChat(chat.id, { maxIterations: toggleContinuous(chat.maxIterations, defaultMax) })
      .catch((e: unknown) => failToast('Não foi possível mudar o modo contínuo', e))
  }

  const generateTitle = (): void => {
    if (titling) return
    setTitling(true)
    useProjects
      .getState()
      .generateTitle(chat.id)
      .catch((e: unknown) => failToast('Não foi possível gerar o título', e))
      .finally(() => setTitling(false))
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-1.5">
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={chat.title}>
        {chat.title}
      </h2>
      <ReasoningChip status={reasoning} />
      <ActiveInstructionsIndicator chatId={chat.id} />
      {budget && <BudgetBar budget={budget} />}
      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={continuous}
              onCheckedChange={setContinuous}
              aria-label="Contínuo"
              className="scale-90"
            />
            Contínuo
          </label>
        </TooltipTrigger>
        <TooltipContent>
          {continuous
            ? 'Sem limite de iterações por turno'
            : `Limite de ${chat.maxIterations ?? defaultMax} iterações por turno`}
        </TooltipContent>
      </Tooltip>
      <BudgetField key={chat.id} chat={chat} />
      <ChatSettingsPanel chat={chat} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Ações do chat" title="Ações do chat">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={titling} onSelect={generateTitle}>
            <Sparkles />
            Gerar título
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
