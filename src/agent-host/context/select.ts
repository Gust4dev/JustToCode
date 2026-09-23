import type { StoredMessage } from '@shared/domain'

/** Texto que abre a mensagem `user` com as imagens devolvidas pelas ferramentas (ver engine/turn.ts). */
export const TOOL_IMAGES_TEXT = 'Images returned by the tool calls above:'

/** Mensagens que pertencem ao grupo `assistant` + `tool` anterior e não podem ser separadas dele. */
function isToolGroupTail(m: StoredMessage): boolean {
  const msg = m.message
  if (msg.role === 'tool') return true
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    const first = msg.content[0]
    return first?.type === 'text' && first.text === TOOL_IMAGES_TEXT
  }
  return false
}

/**
 * Divide o histórico (não compactado, por seq) entre o que vai ser resumido e o que fica.
 * Summaries vigentes (kind 'summary') não contam para `keepRecent` e vão sempre para `toCompact`.
 * Se não há mensagens normais a compactar, `toCompact` volta vazio.
 */
export function selectForCompaction(
  history: StoredMessage[],
  keepRecent: number
): { toCompact: StoredMessage[]; keep: StoredMessage[] } {
  const sorted = [...history].sort((a, b) => a.seq - b.seq)
  const summaries = sorted.filter((m) => m.kind === 'summary')
  const normal = sorted.filter((m) => m.kind !== 'summary')

  let cut = keepRecent <= 0 ? normal.length : normal.length - keepRecent
  while (cut > 0 && cut < normal.length && isToolGroupTail(normal[cut])) cut--
  if (cut <= 0) return { toCompact: [], keep: sorted }

  const toCompact = [...summaries, ...normal.slice(0, cut)].sort((a, b) => a.seq - b.seq)
  return { toCompact, keep: normal.slice(cut) }
}
