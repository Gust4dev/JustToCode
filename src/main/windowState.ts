import { readFileSync, writeFileSync } from 'node:fs'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  bounds: Rect
  maximized: boolean
}

export interface InitialWindow {
  bounds: Rect
  maximized: boolean
}

export const DEFAULT_SIZE = { width: 1440, height: 900 }
export const MIN_SIZE = { width: 1024, height: 640 }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Lê o JSON salvo; qualquer coisa inválida devolve null. */
export function parseWindowState(raw: string): SavedWindowState | null {
  try {
    const v = JSON.parse(raw) as { bounds?: Partial<Rect>; maximized?: unknown } | null
    const b = v?.bounds
    if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) return null
    if (b.width <= 0 || b.height <= 0) return null
    return {
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      maximized: v?.maximized === true
    }
  } catch {
    return null
  }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function clampInto(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width)
  const height = Math.min(r.height, area.height)
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - height)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function centeredDefault(area: Rect): Rect {
  const width = Math.min(DEFAULT_SIZE.width, area.width)
  const height = Math.min(DEFAULT_SIZE.height, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  }
}

/**
 * Decide a posição/tamanho inicial: usa o estado salvo se ele ainda cair em algum monitor
 * (encaixado na área de trabalho desse monitor); senão, 1440×900 centralizado no primário,
 * limitado à área de trabalho.
 */
export function resolveInitialWindow(
  saved: SavedWindowState | null,
  workAreas: Rect[],
  primary: Rect
): InitialWindow {
  if (saved) {
    let best: Rect | null = null
    let bestArea = 0
    for (const wa of workAreas) {
      const a = overlapArea(saved.bounds, wa)
      if (a > bestArea) {
        best = wa
        bestArea = a
      }
    }
    if (best) {
      const bounds = {
        ...saved.bounds,
        width: Math.max(saved.bounds.width, MIN_SIZE.width),
        height: Math.max(saved.bounds.height, MIN_SIZE.height)
      }
      return { bounds: clampInto(bounds, best), maximized: saved.maximized }
    }
  }
  return { bounds: centeredDefault(primary), maximized: false }
}

export function loadWindowState(file: string): SavedWindowState | null {
  try {
    return parseWindowState(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveWindowState(file: string, state: SavedWindowState): void {
  try {
    writeFileSync(file, JSON.stringify(state))
  } catch {
    // não impede o fechamento da janela
  }
}
