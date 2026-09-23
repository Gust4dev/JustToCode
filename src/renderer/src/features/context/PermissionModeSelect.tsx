import { toast } from 'sonner'
import type { PermissionMode } from '@shared/domain'
import { useProjects, findChat, errorMessage } from '@renderer/features/projects/store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { cn } from '@renderer/lib/utils'

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'ask', label: 'Pedir aprovação' },
  { value: 'auto-edit', label: 'Editar livre' },
  { value: 'allow-all', label: 'Permitir tudo' }
]

const DANGER = 'text-red-600 dark:text-red-400'

export function PermissionModeSelect({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useProjects((s) => findChat(s.chats, chatId))
  const updateChat = useProjects((s) => s.updateChat)
  const mode = chat?.permissionMode

  const onChange = (value: string): void => {
    if (!chat || value === chat.permissionMode) return
    updateChat(chat.id, { permissionMode: value as PermissionMode }).catch((e: unknown) =>
      toast.error(`Não foi possível trocar o modo: ${errorMessage(e)}`)
    )
  }

  return (
    <Select value={mode} onValueChange={onChange} disabled={!chat}>
      <SelectTrigger
        size="sm"
        data-chat-id={chatId}
        className={cn('h-7 text-xs', mode === 'allow-all' && `border-red-500/60 ${DANGER}`)}
      >
        <SelectValue placeholder="Permissão" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {MODES.map((m) => (
          <SelectItem
            key={m.value}
            value={m.value}
            className={cn(m.value === 'allow-all' && DANGER)}
          >
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
