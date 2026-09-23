import { useEffect, useMemo, useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import type { Chat } from '@shared/domain'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { call } from '@renderer/lib/host'
import { useUi } from '@renderer/stores/ui'
import { findChat, useProjects } from '@renderer/features/projects/store'
import { ApprovalCard } from './ApprovalCard'
import { pendingApprovals, useApprovals } from './approvalsStore'
import { startApprovalsFeed } from './approvalsFeed'

const countLabel = (n: number): string => (n === 1 ? '1 aprovação' : `${n} aprovações`)

/** Chats de projetos que a sidebar não carregou (só leitura: não mexe no store de projetos). */
function useExtraChats(projectIds: string[], known: Record<string, Chat[]>): Record<string, Chat> {
  const [extra, setExtra] = useState<Record<string, Chat[]>>({})
  const requested = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const key = projectIds.filter((id) => !known[id]).join('|')
  useEffect(() => {
    if (!key) return
    for (const projectId of key.split('|')) {
      if (requested.current.has(projectId)) continue
      requested.current.add(projectId)
      call('chats.list', { projectId })
        .then((list) => {
          if (mounted.current) setExtra((prev) => ({ ...prev, [projectId]: list }))
        })
        .catch(() => {
          // sem nome: a linha mostra "Chat" e continua decidível; tenta de novo na próxima vez
          requested.current.delete(projectId)
        })
    }
  }, [key])
  return useMemo(() => {
    const byId: Record<string, Chat> = {}
    for (const list of Object.values(extra)) for (const c of list) byId[c.id] = c
    return byId
  }, [extra])
}

export function ApprovalsInbox(): React.JSX.Element {
  useEffect(() => startApprovalsFeed(), [])
  const approvals = useApprovals((s) => s.approvals)
  const pending = useMemo(() => pendingApprovals(approvals), [approvals])
  const [openState, setOpen] = useState(false)
  const open = openState && pending.length > 0

  const chats = useProjects((s) => s.chats)
  const projects = useProjects((s) => s.projects)
  const projectIds = useMemo(() => [...new Set(pending.map((a) => a.projectId))], [pending])
  const extraChats = useExtraChats(open ? projectIds : [], chats)

  const selectProject = useUi((s) => s.selectProject)
  const selectChat = useUi((s) => s.selectChat)

  if (pending.length === 0) {
    return (
      <span
        className="inline-flex items-center text-muted-foreground/60"
        title="Nenhuma aprovação pendente"
      >
        <Inbox className="size-4" />
      </span>
    )
  }

  const goToChat = (projectId: string, chatId: string): void => {
    selectProject(projectId)
    selectChat(chatId)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
        >
          <Inbox className="size-3.5" />
          {countLabel(pending.length)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          Aprovações pendentes
        </div>
        <ul className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-3">
          {pending.map((a) => {
            const chat = findChat(chats, a.chatId) ?? extraChats[a.chatId] ?? null
            const project = projects.find((p) => p.id === a.projectId)
            return (
              <li key={a.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 text-left text-xs hover:underline"
                  title="Abrir chat"
                  onClick={() => goToChat(a.projectId, a.chatId)}
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                    style={chat ? { backgroundColor: chat.color } : undefined}
                  />
                  <span className="truncate font-medium">{chat?.title || 'Chat'}</span>
                  {project && (
                    <span className="truncate text-muted-foreground">· {project.name}</span>
                  )}
                </button>
                <ApprovalCard approval={a} />
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
