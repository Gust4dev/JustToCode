import { useEffect } from 'react'
import { toast } from 'sonner'
import { useProjects, findChat, errorMessage } from '@renderer/features/projects/store'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Badge } from '@renderer/components/ui/badge'
import { retainModelsRefresh, useModels } from './modelsStore'

export function ComboSelect({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useProjects((s) => findChat(s.chats, chatId))
  const updateChat = useProjects((s) => s.updateChat)
  const models = useModels((s) => s.models)

  useEffect(() => retainModelsRefresh(), [])

  const current = chat?.combo ?? ''
  const combos = models.filter((m) => m.isCombo)
  const plain = models.filter((m) => !m.isCombo)
  const known = models.some((m) => m.id === current)

  const onChange = (combo: string): void => {
    if (!chat || combo === chat.combo) return
    updateChat(chat.id, { combo }).catch((e: unknown) =>
      toast.error(`Não foi possível trocar a combo: ${errorMessage(e)}`)
    )
  }

  return (
    <Select value={current || undefined} onValueChange={onChange} disabled={!chat}>
      <SelectTrigger size="sm" data-chat-id={chatId} className="h-7 max-w-56 text-xs">
        <SelectValue placeholder="Combo" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {current && !known && <SelectItem value={current}>{current}</SelectItem>}
        {combos.length > 0 && (
          <SelectGroup>
            <SelectLabel>Combos</SelectLabel>
            {combos.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="truncate">{m.id}</span>
                <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                  combo
                </Badge>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {plain.length > 0 && (
          <SelectGroup>
            <SelectLabel>Modelos</SelectLabel>
            {plain.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.id}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {models.length === 0 && !current && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum modelo disponível</div>
        )}
      </SelectContent>
    </Select>
  )
}
