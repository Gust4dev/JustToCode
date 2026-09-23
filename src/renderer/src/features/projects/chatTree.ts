import type { Chat } from '@shared/domain'

// Árvore pai/filho dos chats (subagentes). Pura: só importa de @shared.

export interface ChatNode {
  chat: Chat
  children: Chat[]
}

const byCreated = (a: Chat, b: Chat): number => a.createdAt - b.createdAt

/** Chats de topo (na ordem recebida) com os filhos de cada um, do mais antigo ao mais novo. */
export function buildChatTree(top: Chat[], children: Record<string, Chat[]>): ChatNode[] {
  return top.map((chat) => ({ chat, children: [...(children[chat.id] ?? [])].sort(byCreated) }))
}

/** Procura um chat entre os de topo e os filhos. */
export function findChatIn(
  top: Record<string, Chat[]>,
  children: Record<string, Chat[]>,
  chatId: string | null
): Chat | null {
  if (!chatId) return null
  for (const list of Object.values(top)) {
    const c = list.find((x) => x.id === chatId)
    if (c) return c
  }
  for (const list of Object.values(children)) {
    const c = list.find((x) => x.id === chatId)
    if (c) return c
  }
  return null
}

/** Insere ou troca um filho sob o `parentChatId` dele. Chat sem pai → mapa inalterado. */
export function upsertChild(children: Record<string, Chat[]>, chat: Chat): Record<string, Chat[]> {
  const parent = chat.parentChatId
  if (!parent) return children
  const list = children[parent] ?? []
  const idx = list.findIndex((c) => c.id === chat.id)
  const next = idx >= 0 ? list.map((c) => (c.id === chat.id ? chat : c)) : [...list, chat]
  return { ...children, [parent]: next }
}

/** Tira um chat (e, se for pai, os filhos dele) do mapa de filhos. */
export function removeFromChildren(
  children: Record<string, Chat[]>,
  chatId: string
): Record<string, Chat[]> {
  const out: Record<string, Chat[]> = {}
  for (const [parent, list] of Object.entries(children)) {
    if (parent === chatId) continue
    out[parent] = list.filter((c) => c.id !== chatId)
  }
  return out
}

/** O chat existe no projeto (topo ou filho de um chat de topo do projeto)? */
export function chatInProject(
  top: Chat[],
  children: Record<string, Chat[]>,
  chatId: string
): boolean {
  return top.some((c) => c.id === chatId || (children[c.id] ?? []).some((k) => k.id === chatId))
}
