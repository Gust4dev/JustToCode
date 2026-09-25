import { useRef, useState } from 'react'
import { Bot, ChevronRight, Clock, Loader2, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import type { Chat, ChatGroup } from '@shared/domain'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { ConfirmDialog } from './ConfirmDialog'
import { continueInNewChat, moveChatToGroup, newGroup } from './actions'
import { DND_CHAT, sortGroups } from './groupTree'
import { errorMessage, useProjects } from './store'

const NO_GROUPS: ChatGroup[] = []

function StatusMark({ chat }: { chat: Chat }): React.JSX.Element {
  if (chat.status === 'running')
    return (
      <Loader2
        aria-label="Em execução"
        className="size-3 shrink-0 animate-spin"
        style={{ color: chat.color }}
      />
    )
  if (chat.status === 'waiting_approval')
    return <Clock aria-label="Aguardando aprovação" className="size-3 shrink-0 text-amber-500" />
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        chat.status === 'error' && 'ring-2 ring-destructive/60'
      )}
      style={{ backgroundColor: chat.color }}
    />
  )
}

function RenameInput({ chat, onDone }: { chat: Chat; onDone(): void }): React.JSX.Element {
  const [value, setValue] = useState(chat.title)
  const done = useRef(false)
  const commit = (): void => {
    if (done.current) return
    done.current = true
    onDone()
    const title = value.trim()
    if (!title || title === chat.title) return
    useProjects
      .getState()
      .renameChat(chat.id, title)
      .catch((e) => toast.error(`Não foi possível renomear: ${errorMessage(e)}`))
  }
  return (
    <input
      autoFocus
      aria-label="Nome do chat"
      className="h-5 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          done.current = true
          onDone()
        }
      }}
    />
  )
}

/** Chat filho (subagente): só seleciona; abre em modo leitura. */
function ChildItem({ chat }: { chat: Chat }): React.JSX.Element {
  const selected = useUi((s) => s.chatId === chat.id)
  const running = chat.status === 'running' || chat.status === 'waiting_approval'
  const label = chat.agentName ? `${chat.agentName}: ${chat.title}` : chat.title
  return (
    <div
      role="button"
      tabIndex={0}
      data-chat-id={chat.id}
      title={`Subagente — ${label}`}
      className={cn(
        'flex h-6 cursor-default items-center gap-1.5 rounded-md pr-1 pl-11 text-xs text-foreground/70 outline-none select-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
        selected && 'bg-accent text-accent-foreground'
      )}
      onClick={() => useUi.getState().selectChat(chat.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') useUi.getState().selectChat(chat.id)
      }}
    >
      {running ? (
        <Loader2
          aria-label="Em execução"
          className="size-3 shrink-0 animate-spin"
          style={{ color: chat.color }}
        />
      ) : (
        <Bot aria-hidden className="size-3 shrink-0" style={{ color: chat.color }} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  )
}

export function ChatItem({
  chat,
  childChats = []
}: {
  chat: Chat
  /** Subagentes deste chat (aninhados, recolhíveis). */
  childChats?: Chat[]
}): React.JSX.Element {
  const groups = useProjects((s) => s.groups[chat.projectId] ?? NO_GROUPS)
  const groupsSupported = useProjects((s) => s.groupsSupported)
  const selected = useUi((s) => s.chatId === chat.id)
  const childSelected = useUi((s) => childChats.some((c) => c.id === s.chatId))
  const [editing, setEditing] = useState(false)
  const renameFromMenu = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [openPref, setOpen] = useState<boolean | null>(null)
  const hasChildren = childChats.length > 0
  const anyRunning = childChats.some(
    (c) => c.status === 'running' || c.status === 'waiting_approval'
  )
  const open = openPref ?? (childSelected || anyRunning)

  const remove = (): void => {
    useProjects
      .getState()
      .deleteChat(chat.id)
      .then(() => {
        if (useUi.getState().chatId === chat.id) useUi.getState().selectChat(null)
      })
      .catch((e) => toast.error(`Não foi possível excluir: ${errorMessage(e)}`))
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-chat-id={chat.id}
        draggable={!editing && groupsSupported}
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_CHAT, chat.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        title={editing ? undefined : `${chat.title} — duplo clique para renomear`}
        className={cn(
          'group flex h-7 cursor-default items-center gap-2 rounded-md pr-1 pl-7 text-xs text-foreground/80 outline-none select-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
          selected && 'bg-accent text-accent-foreground'
        )}
        onClick={() => useUi.getState().selectChat(chat.id)}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (editing) return
          if (e.key === 'Enter') useUi.getState().selectChat(chat.id)
          if (e.key === 'F2') setEditing(true)
          if (e.key === 'Delete') setConfirming(true)
        }}
      >
        {hasChildren && (
          <button
            type="button"
            aria-label={open ? 'Recolher subagentes' : 'Mostrar subagentes'}
            aria-expanded={open}
            title={`${childChats.length} subagente${childChats.length === 1 ? '' : 's'}`}
            className="-ml-5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          </button>
        )}
        <StatusMark chat={chat} />
        {editing ? (
          <RenameInput chat={chat} onDone={() => setEditing(false)} />
        ) : (
          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
        )}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Opções do chat"
                title="Opções do chat"
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-52"
              // Eventos do portal sobem pela árvore React até a linha: não selecionar/renomear.
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
              {groupsSupported && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Mover para grupo</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48">
                    <DropdownMenuItem
                      disabled={!chat.groupId}
                      onSelect={() => void moveChatToGroup(chat.id, null)}
                    >
                      Sem grupo
                    </DropdownMenuItem>
                    {sortGroups(groups).map((g) => (
                      <DropdownMenuItem
                        key={g.id}
                        disabled={chat.groupId === g.id}
                        onSelect={() => void moveChatToGroup(chat.id, g.id)}
                      >
                        <span className="truncate">{g.name}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => void newGroup(chat.projectId, 'Novo grupo', chat.id)}
                    >
                      Novo grupo
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem onSelect={() => void continueInNewChat(chat.id)}>
                Continuar em novo chat
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                Excluir
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {hasChildren && open && childChats.map((c) => <ChildItem key={c.id} chat={c} />)}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Excluir chat?"
        description={`"${chat.title}" e todo o histórico dele serão apagados.`}
        confirmLabel="Excluir"
        onConfirm={remove}
      />
    </>
  )
}
