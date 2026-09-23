import type { ChangedFileSummary, Chat } from '@shared/domain'
import { cn } from '@renderer/lib/utils'
import { fileWarning, originLabels } from './origins'

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

export function FileList({
  files,
  chats,
  selected,
  onSelect
}: {
  files: ChangedFileSummary[]
  chats: Map<string, Chat>
  selected: string | null
  onSelect: (path: string) => void
}): React.JSX.Element {
  return (
    <ul className="flex flex-col py-1">
      {files.map((file) => {
        const { name, dir } = splitPath(file.path)
        const warning = fileWarning(
          file,
          file.chatIds.map((id) => chats.get(id)?.title ?? `chat ${id.slice(0, 8)}`)
        )
        const labels = originLabels(file)
        return (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onSelect(file.path)}
              title={file.path}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/60',
                selected === file.path && 'bg-accent text-accent-foreground'
              )}
            >
              <span className="flex shrink-0 items-center gap-0.5">
                {file.chatIds.map((id) => {
                  const chat = chats.get(id)
                  return (
                    <span
                      key={id}
                      title={chat?.title ?? 'Chat desconhecido'}
                      className="size-2 rounded-full bg-muted-foreground/50"
                      style={chat ? { backgroundColor: chat.color } : undefined}
                    />
                  )
                })}
                {warning && (
                  <span title={warning} aria-label={warning} className="text-amber-500">
                    ⚠
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{name}</span>
                {dir && <span className="ml-1.5 text-muted-foreground">{dir}</span>}
                {labels.length > 0 && (
                  <span className="ml-1.5 text-muted-foreground italic">{labels.join(' ')}</span>
                )}
              </span>
              {file.binary ? (
                <span className="shrink-0 text-muted-foreground">binário</span>
              ) : (
                <span className="shrink-0 font-mono tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
                  <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
