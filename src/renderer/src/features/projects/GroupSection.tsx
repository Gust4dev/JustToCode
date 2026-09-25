import { useRef, useState } from 'react'
import { ChevronRight, Folder, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatGroup } from '@shared/domain'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { ChatItem } from './ChatItem'
import { ConfirmDialog } from './ConfirmDialog'
import { moveChatToGroup } from './actions'
import type { ChatNode } from './chatTree'
import {
  DND_CHAT,
  DND_GROUP,
  dropPosition,
  moveGroupBy,
  reorderGroups,
  type DropPosition
} from './groupTree'
import { errorMessage, useProjects } from './store'

type Hint = 'into' | DropPosition | null

const hasType = (e: React.DragEvent, type: string): boolean =>
  Array.from(e.dataTransfer.types).includes(type)

function leaving(e: React.DragEvent): boolean {
  const next = e.relatedTarget as Node | null
  return !next || !e.currentTarget.contains(next)
}

/** Área sem grupo: soltar um chat aqui tira ele do grupo. */
export function UngroupedDropZone({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [hint, setHint] = useState(false)
  return (
    <div
      className={cn('flex flex-col gap-px rounded-md', hint && 'bg-accent/40 ring-1 ring-ring/40')}
      onDragOver={(e) => {
        if (!hasType(e, DND_CHAT)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setHint(true)
      }}
      onDragLeave={(e) => leaving(e) && setHint(false)}
      onDrop={(e) => {
        setHint(false)
        const id = e.dataTransfer.getData(DND_CHAT)
        if (!id) return
        e.preventDefault()
        void moveChatToGroup(id, null)
      }}
    >
      {children}
    </div>
  )
}

function NameInput({
  initial,
  onDone
}: {
  initial: string
  onDone(name: string | null): void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (name: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      autoFocus
      aria-label="Nome do grupo"
      className="h-5 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(value.trim() || null)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

export function GroupSection({
  group,
  chats,
  allGroups,
  renaming,
  onRenamingDone
}: {
  group: ChatGroup
  chats: ChatNode[]
  /** Grupos do projeto (para reordenar). */
  allGroups: ChatGroup[]
  /** Abre já em modo de edição do nome (grupo recém-criado). */
  renaming: boolean
  onRenamingDone(): void
}): React.JSX.Element {
  const selectedChatId = useUi((s) => s.chatId)
  const [editingPref, setEditing] = useState(false)
  const editing = editingPref || renaming
  const renameFromMenu = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [hint, setHint] = useState<Hint>(null)
  const collapsed = group.collapsed
  const index = allGroups.findIndex((g) => g.id === group.id)

  const fail =
    (what: string) =>
    (e: unknown): void => {
      toast.error(`Não foi possível ${what}: ${errorMessage(e)}`)
    }

  const toggle = (): void => {
    useProjects
      .getState()
      .updateGroup(group.id, { collapsed: !collapsed })
      .catch(fail('recolher o grupo'))
  }

  const rename = (name: string | null): void => {
    setEditing(false)
    onRenamingDone()
    if (!name || name === group.name) return
    useProjects.getState().updateGroup(group.id, { name }).catch(fail('renomear o grupo'))
  }

  const reorder = (r: ReturnType<typeof reorderGroups>): void => {
    if (r.changed.length === 0) return
    useProjects
      .getState()
      .reorderGroups(group.projectId, r.groups, r.changed)
      .catch(fail('reordenar os grupos'))
  }

  const remove = (): void => {
    useProjects.getState().deleteGroup(group.id).catch(fail('excluir o grupo'))
  }

  // Recolhido: o chat aberto continua visível para não "sumir" da sidebar.
  const visible = collapsed ? chats.filter((n) => n.chat.id === selectedChatId) : chats

  return (
    <div
      data-group-id={group.id}
      className={cn(
        'relative flex flex-col gap-px rounded-md',
        hint === 'into' && 'bg-accent/40 ring-1 ring-ring/40',
        hint === 'before' &&
          'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:bg-ring',
        hint === 'after' &&
          'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:bg-ring'
      )}
      onDragOver={(e) => {
        const isGroup = hasType(e, DND_GROUP)
        if (!isGroup && !hasType(e, DND_CHAT)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!isGroup) return setHint('into')
        const rect = e.currentTarget.getBoundingClientRect()
        setHint(dropPosition(e.clientY - rect.top, rect.height))
      }}
      onDragLeave={(e) => leaving(e) && setHint(null)}
      onDrop={(e) => {
        const h = hint
        setHint(null)
        const groupId = e.dataTransfer.getData(DND_GROUP)
        if (groupId) {
          e.preventDefault()
          const rect = e.currentTarget.getBoundingClientRect()
          const pos =
            h === 'before' || h === 'after' ? h : dropPosition(e.clientY - rect.top, rect.height)
          reorder(reorderGroups(allGroups, groupId, group.id, pos))
          return
        }
        const chatId = e.dataTransfer.getData(DND_CHAT)
        if (!chatId) return
        e.preventDefault()
        void moveChatToGroup(chatId, group.id)
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        draggable={!editing}
        title={editing ? undefined : `${group.name} — arraste para reordenar`}
        className="group flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs font-medium text-muted-foreground outline-none select-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_GROUP, group.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => !editing && toggle()}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (editing) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
          if (e.key === 'F2') setEditing(true)
          if (e.key === 'Delete') setConfirming(true)
          if (e.altKey && e.key === 'ArrowUp') reorder(moveGroupBy(allGroups, group.id, -1))
          if (e.altKey && e.key === 'ArrowDown') reorder(moveGroupBy(allGroups, group.id, 1))
        }}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', !collapsed && 'rotate-90')}
        />
        <Folder className="size-3 shrink-0" />
        {editing ? (
          <NameInput initial={group.name} onDone={rename} />
        ) : (
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
        )}
        {!editing && collapsed && chats.length > 0 && (
          <span className="shrink-0 text-[10px] font-normal tabular-nums">{chats.length}</span>
        )}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Opções do grupo"
                className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-48"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onCloseAutoFocus={(e) => {
                if (renameFromMenu.current) {
                  renameFromMenu.current = false
                  e.preventDefault()
                  setEditing(true)
                }
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  renameFromMenu.current = true
                }}
              >
                Renomear
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index <= 0}
                onSelect={() => reorder(moveGroupBy(allGroups, group.id, -1))}
              >
                Mover para cima
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index < 0 || index >= allGroups.length - 1}
                onSelect={() => reorder(moveGroupBy(allGroups, group.id, 1))}
              >
                Mover para baixo
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                Excluir grupo
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!collapsed && chats.length === 0 && (
        <div className="flex h-6 items-center pl-7 text-[11px] text-muted-foreground/70 italic">
          arraste chats para cá
        </div>
      )}
      {visible.map((n) => (
        <ChatItem key={n.chat.id} chat={n.chat} childChats={n.children} />
      ))}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Excluir grupo?"
        description={`O grupo "${group.name}" será removido. Os chats dele não são apagados: ficam sem grupo.`}
        confirmLabel="Excluir"
        onConfirm={remove}
      />
    </div>
  )
}
