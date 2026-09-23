import { X } from 'lucide-react'
import { formatBytes, type DraftAttachment } from './attachments'

export function AttachmentChips({
  items,
  onRemove
}: {
  items: DraftAttachment[]
  onRemove(id: string): void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {items.map((a) => (
        <div
          key={a.id}
          className="group flex h-9 max-w-52 items-center gap-2 rounded-md border bg-background pr-1 pl-1 text-xs"
          title={a.name}
        >
          <img src={a.dataUrl} alt="" className="size-7 shrink-0 rounded object-cover" />
          <div className="min-w-0 leading-tight">
            <div className="truncate">{a.name}</div>
            <div className="text-[10px] text-muted-foreground">{formatBytes(a.bytes)}</div>
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
