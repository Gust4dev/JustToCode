import type { InstallPreviewItem } from '@shared/domain'

export type Suspicious = InstallPreviewItem['suspicious'][number]

const NAMES: Record<number, string> = {
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE'
}

const inRange = (cp: number, a: number, b: number): boolean => cp >= a && cp <= b

/** Nome do codepoint suspeito, ou `null` se ele é permitido. `first` = início do texto (BOM ok). */
function suspiciousName(cp: number, first: boolean): string | null {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return null
  if (cp <= 0x1f || cp === 0x7f) return 'CONTROL CHARACTER'
  if (inRange(cp, 0x80, 0x9f)) return 'C1 CONTROL CHARACTER'
  if (cp === 0xfeff) return first ? null : NAMES[cp]
  if (
    inRange(cp, 0x200b, 0x200f) ||
    inRange(cp, 0x202a, 0x202e) ||
    inRange(cp, 0x2060, 0x2064) ||
    inRange(cp, 0x2066, 0x2069)
  ) {
    return NAMES[cp]
  }
  if (inRange(cp, 0xe0000, 0xe007f)) return 'TAG CHARACTER'
  return null
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * Procura codepoints invisíveis/de formatação (zero-width, bidi, tags) e controles (exceto
 * \t \r \n). `line`/`col` começam em 1; `col` conta codepoints.
 */
export function scanText(text: string): Suspicious[] {
  const out: Suspicious[] = []
  let line = 1
  let col = 0
  let first = true
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    col++
    const name = suspiciousName(cp, first)
    first = false
    if (name) out.push({ line, col, codepoint: hex(cp), name })
    if (cp === 0x0a) {
      line++
      col = 0
    }
  }
  return out
}
