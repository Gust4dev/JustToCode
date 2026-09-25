export type UpdateState =
  // idle: nunca verificado (ou última verificação automática falhou em silêncio).
  | { phase: 'idle' }
  | { phase: 'checking' }
  // none: verificado e não há atualização (a UI mostra "versão mais recente").
  | { phase: 'none' }
  | { phase: 'available'; version: string; notes: string }
  | { phase: 'downloading'; version: string; notes: string; percent: number }
  | { phase: 'ready'; version: string; notes: string }
  | { phase: 'error'; message: string }

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'none' }
  | { type: 'available'; version: string; notes: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  // silent: erro de verificação automática (startup/periódica/foco) — não incomoda o usuário.
  | { type: 'error'; message: string; silent?: boolean }

export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'check':
      return s.phase === 'downloading' || s.phase === 'ready' ? s : { phase: 'checking' }
    case 'none':
      return { phase: 'none' }
    case 'available':
      return { phase: 'available', version: e.version, notes: e.notes }
    case 'progress':
      if (s.phase !== 'available' && s.phase !== 'downloading') return s
      return {
        phase: 'downloading',
        version: s.version,
        notes: s.notes,
        percent: Math.round(e.percent)
      }
    case 'downloaded':
      return s.phase === 'available' || s.phase === 'downloading'
        ? { phase: 'ready', version: s.version, notes: s.notes }
        : s
    case 'error':
      if (e.silent) return s.phase === 'downloading' || s.phase === 'ready' ? s : { phase: 'idle' }
      return { phase: 'error', message: e.message }
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' '
}

const decodeEntities = (t: string): string =>
  t.replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] ?? m)

/**
 * Converte o HTML do changelog do GitHub em markdown simples (texto puro: nada é executado).
 * li → "- ", p/br → quebras, a → [texto](url), strong/b → **, code → `, demais tags removidas.
 */
export function htmlToMarkdown(html: string): string {
  if (!/<[a-z!/][^>]*>/i.test(html)) return html
  const md = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q, href, text) => `[${text}](${href})`
    )
    .replace(/<\/?(strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/?code\b[^>]*>/gi, '`')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(md)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeNotes(n: string | { note: string | null }[] | null | undefined): string {
  if (!n) return ''
  if (typeof n === 'string') return htmlToMarkdown(n)
  return n
    .map((x) => (x.note ? htmlToMarkdown(x.note) : x.note))
    .filter(Boolean)
    .join('\n\n')
}
