import { useEffect, useState } from 'react'
import { FileText, X } from 'lucide-react'
import type { ComboInfo } from '@shared/domain'
import { supportsPdf } from '@shared/attachmentKinds'
import { call } from '@renderer/lib/host'
import { findChat, useProjects } from '@renderer/features/projects/store'
import { useModels } from '@renderer/features/context/modelsStore'
import { formatBytes, plannedDelivery, typeLabel, type DraftAttachment } from './attachments'

/** O combo do chat aceita PDF nativo? (só consulta o combo quando há PDF no rascunho) */
function usePdfNative(chatId: string, wanted: boolean): boolean {
  const combo = useProjects((s) => findChat(s.chats, chatId)?.combo ?? '')
  const models = useModels((s) => s.models)
  const [info, setInfo] = useState<{ combo: string; info: ComboInfo | null } | null>(null)
  const isCombo = models.find((m) => m.id === combo)?.isCombo ?? true
  useEffect(() => {
    if (!wanted || !combo || !isCombo || info?.combo === combo) return
    let alive = true
    call('combos.info', { combo })
      .then((i) => alive && setInfo({ combo, info: i }))
      .catch(() => alive && setInfo({ combo, info: null }))
    return () => {
      alive = false
    }
  }, [wanted, combo, isCombo, info?.combo])
  if (!wanted || !combo) return false
  if (!isCombo) return supportsPdf(null, combo, models)
  return info?.combo === combo && info.info ? supportsPdf(info.info, combo, models) : false
}

export function AttachmentChips({
  chatId,
  items,
  onRemove
}: {
  chatId: string
  items: DraftAttachment[]
  onRemove(id: string): void
}): React.JSX.Element | null {
  const pdfNative = usePdfNative(
    chatId,
    items.some((a) => a.cls === 'pdf')
  )
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {items.map((a) => (
        <div
          key={a.id}
          className="group flex h-9 max-w-60 items-center gap-2 rounded-md border bg-background pr-1 pl-1 text-xs"
          title={a.name}
        >
          {a.cls === 'image' ? (
            <img src={a.dataUrl} alt="" className="size-7 shrink-0 rounded object-cover" />
          ) : (
            <div className="flex size-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              <FileText className="size-4" />
            </div>
          )}
          <div className="min-w-0 leading-tight">
            <div className="truncate">{a.name}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {typeLabel(a.name, a.mime)} · {formatBytes(a.bytes)} · vai como{' '}
              {plannedDelivery(a.cls, pdfNative)}
            </div>
          </div>
          <button
            type="button"
            aria-label={`Remover ${a.name}`}
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onRemove(a.id)}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
