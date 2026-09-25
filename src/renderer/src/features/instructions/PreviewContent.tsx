import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { InstallPreviewItem } from '@shared/domain'
import { cn } from '@renderer/lib/utils'
import { describeSuspicious, markContent, type DiffLine } from './libraryLogic'

/** Lista de suspeitos de um item (linha/coluna/codepoint). */
export function SuspiciousList({
  item
}: {
  item: Pick<InstallPreviewItem, 'suspicious'>
}): React.JSX.Element | null {
  if (item.suspicious.length === 0) return null
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="size-3.5" />
        Caracteres invisíveis/bidi encontrados: este item não pode ser instalado.
      </p>
      <ul className="mt-1 max-h-28 overflow-auto font-mono text-[11px] text-destructive/90">
        {item.suspicious.slice(0, 50).map((s, idx) => (
          <li key={idx}>{describeSuspicious(s)}</li>
        ))}
        {item.suspicious.length > 50 && <li>… e mais {item.suspicious.length - 50}</li>}
      </ul>
    </div>
  )
}

/** Conteúdo do item com números de linha e os caracteres suspeitos destacados. */
export function PreviewContent({
  item,
  className
}: {
  item: Pick<InstallPreviewItem, 'content' | 'suspicious'>
  className?: string
}): React.JSX.Element {
  const lines = useMemo(() => markContent(item.content, item.suspicious), [item])
  return (
    <pre
      className={cn(
        'overflow-auto rounded-md border bg-muted/30 py-2 font-mono text-[11px] leading-relaxed',
        className
      )}
    >
      {lines.map((l) => (
        <div key={l.line} className={cn('flex px-2', l.flagged && 'bg-destructive/10')}>
          <span className="w-9 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">
            {l.line}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-all">
            {l.segments.map((s, i) =>
              s.suspicious ? (
                <mark
                  key={i}
                  title={`${s.suspicious} ${s.name ?? ''}`}
                  className="rounded-sm bg-destructive px-0.5 text-[10px] text-white"
                >
                  {s.suspicious}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              )
            )}
          </span>
        </div>
      ))}
    </pre>
  )
}

/** Diff de linhas (atualização). */
export function DiffView({
  diff,
  className
}: {
  diff: DiffLine[]
  className?: string
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'overflow-auto rounded-md border bg-muted/30 py-2 font-mono text-[11px] leading-relaxed',
        className
      )}
    >
      {diff.map((l, i) => (
        <div
          key={i}
          className={cn(
            'px-2 whitespace-pre-wrap break-all',
            l.type === 'add' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            l.type === 'del' && 'bg-destructive/10 text-destructive'
          )}
        >
          <span className="select-none">
            {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
          </span>
          {l.text}
        </div>
      ))}
    </pre>
  )
}
