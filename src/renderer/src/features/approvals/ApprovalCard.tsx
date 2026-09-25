import { Check, CheckCheck, FileEdit, Terminal, TriangleAlert, X } from 'lucide-react'
import type { Approval } from '@shared/domain'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { findAnyChat, useProjects } from '@renderer/features/projects/store'
import { useApprovals } from './approvalsStore'
import { splitAlwaysConfirm, splitApprovalFlags } from './collision'
import { decideApproval } from './approvalsFeed'

/** "edit src/a.ts" → "Editar src/a.ts"; "write x" → "Escrever x". */
function editLabel(summary: string): string {
  const m = /^(edit|write)\s+(.+)$/s.exec(summary)
  if (!m) return summary
  return `${m[1] === 'write' ? 'Escrever' : 'Editar'} ${m[2]}`
}

function CollisionBadge({ chatId }: { chatId: string }): React.JSX.Element {
  const title = useProjects((s) => findAnyChat(s, chatId)?.title ?? null)
  const name = title ?? `chat ${chatId.slice(0, 8)}`
  return (
    <Badge
      variant="outline"
      title="Outro chat tem mudanças não revisadas neste arquivo"
      className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    >
      <TriangleAlert />
      outro chat mexeu aqui ({name})
    </Badge>
  )
}

function ResultLine({ approval }: { approval: Approval }): React.JSX.Element {
  const when = approval.decidedAt
    ? new Date(approval.decidedAt).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })
    : null
  return (
    <span className="text-xs text-muted-foreground">
      {approval.status === 'allowed' ? 'Permitido' : 'Negado'}
      {when && ` às ${when}`}
    </span>
  )
}

export function ApprovalCard({ approval }: { approval: Approval }): React.JSX.Element {
  // O estado vivo (vindo dos eventos) vence a prop, que pode estar desatualizada.
  const live = useApprovals((s) => s.approvals.find((a) => a.id === approval.id)) ?? approval
  const deciding = useApprovals((s) => Boolean(s.deciding[approval.id]))
  const pending = live.status === 'pending'
  const Icon = live.kind === 'command' ? Terminal : FileEdit
  const split = splitApprovalFlags(live.flags)
  const { collisions } = split
  const { reasons, rest: others } = splitAlwaysConfirm(split.others)

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2 text-sm',
        pending ? 'border-amber-500/40 bg-amber-500/5' : 'text-muted-foreground'
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', pending && 'text-amber-600')} />
        {live.kind === 'command' ? (
          <code className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap">
            {live.summary}
          </code>
        ) : (
          <span className="min-w-0 flex-1 break-all">{editLabel(live.summary)}</span>
        )}
      </div>
      {live.flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {collisions.map((id) => (
            <CollisionBadge key={`c-${id}`} chatId={id} />
          ))}
          {reasons.map((r) => (
            <Badge
              key={`a-${r}`}
              variant="outline"
              title="Este pedido sempre pede confirmação, mesmo com permissões liberadas"
              className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            >
              <TriangleAlert />
              Sempre confirmar: {r}
            </Badge>
          ))}
          {others.map((f) => (
            <Badge key={f} variant="outline" className="text-amber-700 dark:text-amber-400">
              {f}
            </Badge>
          ))}
        </div>
      )}
      {pending ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            disabled={deciding}
            onClick={() => void decideApproval(live.id, 'allow', false)}
          >
            <Check />
            Permitir
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={deciding}
            title={
              live.kind === 'command'
                ? 'Permitir e não perguntar de novo para comandos parecidos neste projeto'
                : 'Permitir e não perguntar de novo para edições neste projeto'
            }
            onClick={() => void decideApproval(live.id, 'allow', true)}
          >
            <CheckCheck />
            Sempre
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={deciding}
            onClick={() => void decideApproval(live.id, 'deny', false)}
          >
            <X />
            Negar
          </Button>
        </div>
      ) : (
        <ResultLine approval={live} />
      )}
    </div>
  )
}
