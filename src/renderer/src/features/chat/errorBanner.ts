/** Ação oferecida pelo banner de erro do turno, conforme o `code` do `turn_error`. */
export type ErrorAction = 'settings' | 'router-dashboard' | null

export function errorAction(code: string | undefined): ErrorAction {
  if (code === 'AUTH') return 'settings'
  if (code === 'MODEL_GONE') return 'router-dashboard'
  return null
}

export interface MessageSegment {
  text: string
  code: boolean
}

/** Quebra a mensagem em trechos normais e trechos entre crases (`x` → código inline). */
export function splitInlineCode(message: string): MessageSegment[] {
  const out: MessageSegment[] = []
  const re = /`([^`]+)`/g
  let last = 0
  for (let m = re.exec(message); m; m = re.exec(message)) {
    if (m.index > last) out.push({ text: message.slice(last, m.index), code: false })
    out.push({ text: m[1], code: true })
    last = m.index + m[0].length
  }
  if (last < message.length) out.push({ text: message.slice(last), code: false })
  return out
}
