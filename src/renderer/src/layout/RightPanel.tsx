import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'

const WIDTH_KEY = 'jtc.ui.rightPanelWidth'
export const PANEL_MIN = 320
export const PANEL_MAX_RATIO = 0.6
const PANEL_DEFAULT = 520

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n >= PANEL_MIN ? n : PANEL_DEFAULT
  } catch {
    return PANEL_DEFAULT
  }
}

function writeWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)))
  } catch {
    // preferência só na memória
  }
}

/** Limita a largura a [320, 60% da linha]; se 60% < 320, prevalece o mínimo. */
function clampWidth(w: number, rowWidth: number): number {
  const max = rowWidth > 0 ? rowWidth * PANEL_MAX_RATIO : Infinity
  return Math.round(Math.max(PANEL_MIN, Math.min(w, max)))
}

/**
 * Linha "conversa | divisor | painel direito". O divisor arrasta a largura do painel,
 * que fica salva em localStorage.
 */
export function SplitWithRightPanel({
  main,
  panel
}: {
  main: React.ReactNode
  panel: React.ReactNode | null
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState(0)
  const [width, setWidth] = useState(readWidth)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setRowWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const effective = clampWidth(width, rowWidth)

  const widthFromPointer = (clientX: number): number => {
    const rect = rowRef.current?.getBoundingClientRect()
    return rect ? clampWidth(rect.right - clientX, rect.width) : width
  }

  const commit = (w: number): void => {
    setWidth(w)
    writeWidth(w)
  }

  return (
    <div
      ref={rowRef}
      className={cn('flex min-h-0 flex-1', dragging && 'cursor-col-resize select-none')}
    >
      <main className="min-w-0 flex-1">{main}</main>
      {panel && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Redimensionar painel de alterações"
            aria-valuenow={effective}
            aria-valuemin={PANEL_MIN}
            tabIndex={0}
            title="Arraste para redimensionar · duplo clique restaura"
            className={cn(
              'group relative w-px shrink-0 cursor-col-resize bg-border outline-none',
              'focus-visible:bg-ring'
            )}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              setDragging(true)
            }}
            onPointerMove={(e) => {
              if (dragging) setWidth(widthFromPointer(e.clientX))
            }}
            onPointerUp={(e) => {
              if (!dragging) return
              setDragging(false)
              commit(widthFromPointer(e.clientX))
            }}
            onPointerCancel={() => {
              setDragging(false)
              writeWidth(width)
            }}
            onDoubleClick={() => commit(clampWidth(PANEL_DEFAULT, rowWidth))}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 64 : 16
              if (e.key === 'ArrowLeft') commit(clampWidth(effective + step, rowWidth))
              if (e.key === 'ArrowRight') commit(clampWidth(effective - step, rowWidth))
            }}
          >
            {/* área de pega mais larga que a linha de 1px */}
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-0 -left-1 w-2 transition-colors group-hover:bg-ring/40',
                dragging && 'bg-ring/60'
              )}
            />
          </div>
          <aside style={{ width: effective }} className="min-w-0 shrink-0">
            {panel}
          </aside>
        </>
      )}
    </div>
  )
}
