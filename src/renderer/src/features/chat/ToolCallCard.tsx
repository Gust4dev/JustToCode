import { createElement, useState } from 'react'
import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  CircleSlash,
  Clock,
  ExternalLink,
  LoaderCircle,
  X
} from 'lucide-react'
import type { Approval, ToolCallStatus } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { openChildChat } from '@renderer/features/projects/actions'
import { ApprovalCard } from '@renderer/features/approvals/ApprovalCard'
import type { LiveToolCall } from './chatStore'
import { summarizeTool, toolIcon } from './toolInfo'
import { useSubagents } from './SubagentContext'
import { TASK_TOOL, taskArgs } from './subagents'

const STATUS: Record<ToolCallStatus, { label: string; className: string }> = {
  pending: { label: 'na fila', className: 'text-muted-foreground' },
  awaiting_approval: {
    label: 'aguardando aprovação',
    className: 'text-amber-600 dark:text-amber-400'
  },
  running: { label: 'executando', className: 'text-muted-foreground' },
  done: { label: 'ok', className: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: 'erro', className: 'text-destructive' },
  denied: { label: 'negado', className: 'text-muted-foreground' },
  cancelled: { label: 'cancelado', className: 'text-muted-foreground' }
}

function StatusIcon({ status }: { status: ToolCallStatus }): React.JSX.Element {
  const cls = cn('size-3.5 shrink-0', STATUS[status].className)
  switch (status) {
    case 'pending':
    case 'running':
      return <LoaderCircle className={cn(cls, 'animate-spin')} />
    case 'awaiting_approval':
      return <Clock className={cls} />
    case 'done':
      return <Check className={cls} />
    case 'error':
      return <X className={cls} />
    case 'denied':
      return <Ban className={cls} />
    case 'cancelled':
      return <CircleSlash className={cls} />
  }
}

function duration(tc: LiveToolCall): string | null {
  if (!tc.startedAt || !tc.finishedAt) return null
  const ms = tc.finishedAt - tc.startedAt
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`
}

/** Cabeçalho extra do card da `task`: agente, descrição, status do filho e o link para a conversa. */
function SubagentInfo({ toolCall }: { toolCall: LiveToolCall }): React.JSX.Element {
  const link = useSubagents()[toolCall.id]
  const { agent, description } = taskArgs(toolCall.args)
  const agentName = link?.agentName || agent
  const state = link
    ? link.running
      ? 'subagente trabalhando…'
      : 'subagente terminou'
    : toolCall.status === 'pending' || toolCall.status === 'running'
      ? 'iniciando subagente…'
      : null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-2.5 py-1.5">
      <Bot className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium">{agentName}</span>
      {description && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={description}>
          {description}
        </span>
      )}
      {state && <span className="shrink-0 text-muted-foreground/80">{state}</span>}
      {link && (
        <button
          type="button"
          className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => void openChildChat(toolCall.chatId, link.childChatId)}
        >
          <ExternalLink className="size-3" />
          abrir conversa do subagente
        </button>
      )}
    </div>
  )
}

export function ToolCallCard({
  toolCall,
  approval
}: {
  toolCall: LiveToolCall
  approval?: Approval
}): React.JSX.Element {
  // Aprovação pendente manda no rótulo, mesmo que o engine ainda não tenha reemitido o status.
  const status: ToolCallStatus =
    approval?.status === 'pending' &&
    (toolCall.status === 'pending' || toolCall.status === 'running')
      ? 'awaiting_approval'
      : toolCall.status
  const live = status === 'running' || status === 'pending'
  const [open, setOpen] = useState<boolean | null>(null)
  const [full, setFull] = useState<string | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const expanded = open ?? (live && toolCall.liveOutput.length > 0)

  const summary = summarizeTool(toolCall.name, toolCall.args)
  const output =
    full ?? (live ? toolCall.liveOutput : (toolCall.outputPreview ?? toolCall.liveOutput))
  const took = duration(toolCall)

  const loadFull = async (): Promise<void> => {
    setLoadingFull(true)
    try {
      setFull((await call('toolCalls.output', { id: toolCall.id })).text)
    } catch {
      // mantém a prévia
    } finally {
      setLoadingFull(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-md border bg-card text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        {createElement(toolIcon(toolCall.name), {
          className: 'size-3.5 shrink-0 text-muted-foreground'
        })}
        <span className="min-w-0 flex-1 truncate font-mono" title={summary}>
          {summary}
        </span>
        {took && <span className="shrink-0 text-muted-foreground/70">{took}</span>}
        <span className={cn('shrink-0', STATUS[status].className)}>{STATUS[status].label}</span>
        <StatusIcon status={status} />
      </button>
      {toolCall.name === TASK_TOOL && <SubagentInfo toolCall={toolCall} />}
      {expanded && (
        <div className="border-t bg-muted/30">
          {output ? (
            <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
              {output}
            </pre>
          ) : (
            <div className="px-3 py-2 text-muted-foreground">
              {live ? 'Aguardando saída…' : 'Sem saída.'}
            </div>
          )}
          {toolCall.outputTruncated && full === null && !live && (
            <div className="border-t px-3 py-1.5">
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                disabled={loadingFull}
                onClick={() => void loadFull()}
              >
                {loadingFull ? 'Carregando…' : 'Saída cortada · carregar completa'}
              </button>
            </div>
          )}
        </div>
      )}
      {approval && (
        <div className="border-t p-2">
          <ApprovalCard approval={approval} />
        </div>
      )}
    </div>
  )
}
