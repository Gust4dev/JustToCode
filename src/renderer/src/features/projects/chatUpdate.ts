import type { Chat } from '@shared/domain'

// Aplica um `chat_updated` aos chats carregados. Pura: só importa de @shared.

/**
 * Troca o chat (topo ou filho) pelo novo valor, mantendo a posição. Devolve null quando o chat
 * não está carregado (nada a fazer).
 */
export function applyChatUpdate(
  top: Record<string, Chat[]>,
  children: Record<string, Chat[]>,
  chat: Chat
): { chats: Record<string, Chat[]>; children: Record<string, Chat[]> } | null {
  for (const [pid, list] of Object.entries(top)) {
    if (list.some((c) => c.id === chat.id))
      return {
        chats: { ...top, [pid]: list.map((c) => (c.id === chat.id ? chat : c)) },
        children
      }
  }
  for (const [parent, list] of Object.entries(children)) {
    if (list.some((c) => c.id === chat.id))
      return {
        chats: top,
        children: { ...children, [parent]: list.map((c) => (c.id === chat.id ? chat : c)) }
      }
  }
  return null
}
