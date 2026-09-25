import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatGroup, Project } from '@shared/domain'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { ChatItem } from './ChatItem'
import { ConfirmDialog } from './ConfirmDialog'
import { GroupSection, UngroupedDropZone } from './GroupSection'
import { newChat, newGroup } from './actions'
import { buildSidebarTree, sortGroups } from './groupTree'
import { errorMessage, useProjects } from './store'

const NO_GROUPS: ChatGroup[] = []

function ProjectChats({
  projectId,
  renamingGroupId,
  onRenamingDone
}: {
  projectId: string
  renamingGroupId: string | null
  onRenamingDone(): void
}): React.JSX.Element {
  const chats = useProjects((s) => s.chats[projectId])
  const error = useProjects((s) => s.chatsError[projectId] ?? null)
  const children = useProjects((s) => s.children)
  const groups = useProjects((s) => s.groups[projectId] ?? NO_GROUPS)
  const groupsSupported = useProjects((s) => s.groupsSupported)
  const tree = useMemo(
    () => buildSidebarTree(groupsSupported ? groups : NO_GROUPS, chats ?? [], children),
    [groupsSupported, groups, chats, children]
  )
  const sorted = useMemo(() => sortGroups(groups), [groups])
  const ungrouped = tree.ungrouped.map((n) => (
    <ChatItem key={n.chat.id} chat={n.chat} childChats={n.children} />
  ))
  return (
    <div className="flex flex-col gap-px pb-1">
      <button
        type="button"
        className="flex h-7 items-center gap-2 rounded-md pr-1 pl-7 text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => void newChat(projectId)}
      >
        <Plus className="size-3" />
        Novo chat
      </button>
      {error && (
        <button
          type="button"
          title={error}
          className="flex h-7 items-center gap-2 rounded-md pr-1 pl-7 text-left text-xs text-destructive hover:bg-accent/60"
          onClick={() => void useProjects.getState().loadChats(projectId)}
        >
          <RotateCw className="size-3 shrink-0" />
          <span className="truncate">Erro ao carregar chats</span>
        </button>
      )}
      {tree.groups.length > 0 ? <UngroupedDropZone>{ungrouped}</UngroupedDropZone> : ungrouped}
      {tree.groups.map((g) => (
        <GroupSection
          key={g.group.id}
          group={g.group}
          chats={g.chats}
          allGroups={sorted}
          renaming={renamingGroupId === g.group.id}
          onRenamingDone={onRenamingDone}
        />
      ))}
    </div>
  )
}

function ProjectItem({ project }: { project: Project }): React.JSX.Element {
  const selected = useUi((s) => s.projectId === project.id)
  const [confirming, setConfirming] = useState(false)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const groupsSupported = useProjects((s) => s.groupsSupported)

  const addGroup = (): void => {
    if (!selected) useUi.getState().selectProject(project.id)
    void newGroup(project.id, 'Novo grupo').then((id) => id && setRenamingGroupId(id))
  }

  const remove = (): void => {
    useProjects
      .getState()
      .removeProject(project.id)
      .then(() => {
        if (useUi.getState().projectId === project.id) useUi.getState().selectProject(null)
      })
      .catch((e) => toast.error(`Não foi possível remover: ${errorMessage(e)}`))
  }

  return (
    <div>
      <div
        className={cn(
          'group flex h-7 items-center gap-1 rounded-md pr-1 text-sm hover:bg-accent/60',
          selected && 'font-medium'
        )}
      >
        <button
          type="button"
          title={project.path}
          className="flex h-full min-w-0 flex-1 items-center gap-1 pl-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => useUi.getState().selectProject(project.id)}
        >
          {selected ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{project.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Opções do projeto"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={() => void newChat(project.id)}>Novo chat</DropdownMenuItem>
            {groupsSupported && <DropdownMenuItem onSelect={addGroup}>Novo grupo</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
              Remover da lista
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {selected && (
        <ProjectChats
          projectId={project.id}
          renamingGroupId={renamingGroupId}
          onRenamingDone={() => setRenamingGroupId(null)}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remover projeto da lista?"
        description={`Os chats de "${project.name}" deixam de aparecer. Os arquivos em ${project.path} não são apagados.`}
        confirmLabel="Remover"
        onConfirm={remove}
      />
    </div>
  )
}

export function ProjectList(): React.JSX.Element {
  const projects = useProjects((s) => s.projects)
  const loaded = useProjects((s) => s.projectsLoaded)
  const error = useProjects((s) => s.projectsError)

  if (error && !loaded)
    return (
      <div className="flex flex-col gap-2 px-3 py-2 text-xs text-destructive">
        <span title={error}>Erro ao carregar projetos.</span>
        <button
          type="button"
          className="w-fit text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => void useProjects.getState().loadProjects()}
        >
          Tentar de novo
        </button>
      </div>
    )
  if (!loaded) return <div className="px-3 py-2 text-xs text-muted-foreground">Carregando…</div>
  if (projects.length === 0)
    return <div className="px-3 py-2 text-xs text-muted-foreground">Nenhum projeto aberto.</div>
  return (
    <div className="flex flex-col gap-px px-2 py-1">
      {projects.map((p) => (
        <ProjectItem key={p.id} project={p} />
      ))}
    </div>
  )
}
