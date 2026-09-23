export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

const FENCE = /^---[ \t]*$/

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function scalar(v: string): unknown {
  const t = v.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return unquote(t)
}

function inlineList(v: string): string[] {
  const inner = v.trim().slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((s) => unquote(s))
    .filter((s) => s !== '')
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * YAML simples de frontmatter: `key: value`, listas `[a, b]` ou `- item`, e blocos `|`/`>`.
 * Sem frontmatter (ou sem fechamento) → `data` vazio e `body` = texto inteiro.
 */
export function parseFrontmatter(md: string): Frontmatter {
  const text = md.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (!lines.length || !FENCE.test(lines[0])) return { data: {}, body: text }
  const end = lines.findIndex((l, i) => i > 0 && FENCE.test(l))
  if (end < 0) return { data: {}, body: text }

  const data: Record<string, unknown> = {}
  const head = lines.slice(1, end)
  for (let i = 0; i < head.length; i++) {
    const line = head[i]
    if (!line.trim() || line.trimStart().startsWith('#') || indentOf(line) > 0) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    const rest = m[2].trim()
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = inlineList(rest)
    } else if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const block: string[] = []
      while (i + 1 < head.length && (head[i + 1].trim() === '' || indentOf(head[i + 1]) > 0)) {
        block.push(head[++i].trim())
      }
      while (block.length && block[block.length - 1] === '') block.pop()
      data[key] = rest.startsWith('|')
        ? block.join('\n')
        : block.join(' ').replace(/\s+/g, ' ').trim()
    } else if (rest === '') {
      const items: string[] = []
      while (i + 1 < head.length && /^\s*-\s+/.test(head[i + 1])) {
        items.push(unquote(head[++i].replace(/^\s*-\s+/, '')))
      }
      data[key] = items.length ? items : ''
    } else {
      data[key] = scalar(rest)
    }
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\s*\n/, '')
  return { data, body }
}

/** Valor do frontmatter como texto (vazio se ausente). */
export function fmString(data: Record<string, unknown>, key: string): string {
  const v = data[key]
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v).trim()
}
