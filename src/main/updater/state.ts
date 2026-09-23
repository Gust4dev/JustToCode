export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
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
  // silent: erro de verificação automática (startup/horária) — não incomoda o usuário.
  | { type: 'error'; message: string; silent?: boolean }

export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'check':
      return s.phase === 'downloading' || s.phase === 'ready' ? s : { phase: 'checking' }
    case 'none':
      return { phase: 'idle' }
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

export function normalizeNotes(n: string | { note: string | null }[] | null | undefined): string {
  if (!n) return ''
  if (typeof n === 'string') return n
  return n
    .map((x) => x.note)
    .filter(Boolean)
    .join('\n\n')
}
