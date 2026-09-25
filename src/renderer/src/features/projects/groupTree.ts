import type { Chat, ChatGroup } from '@shared/domain'
import { buildChatTree, type ChatNode } from './chatTree'

// Árvore grupos → chats → subagentes da sidebar e reordenação de grupos. Pura: só importa de @shared.

export interface GroupNode {
  group: ChatGroup
  chats: ChatNode[]
}

export interface SidebarTree {
  /** Chats sem grupo (ou com grupo desconhecido), sempre no topo. */
  ungrouped: ChatNode[]
  groups: GroupNode[]
}

/** Grupos por `sortOrder`; empate → mais antigo primeiro, depois id (ordem estável). */
export function sortGroups(groups: ChatGroup[]): ChatGroup[] {
  return [...groups].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
}

/**
 * Monta a árvore da sidebar. Chats de cada grupo mantêm a ordem recebida (host: mais novo
 * primeiro); os filhos (subagentes) seguem aninhados como em `buildChatTree`.
 */
export function buildSidebarTree(
  groups: ChatGroup[],
  top: Chat[],
  children: Record<string, Chat[]>
): SidebarTree {
  const nodes = buildChatTree(top, children)
  const known = new Set(groups.map((g) => g.id))
  const byGroup = new Map<string, ChatNode[]>()
  const ungrouped: ChatNode[] = []
  for (const n of nodes) {
    const gid = n.chat.groupId
    if (gid && known.has(gid)) {
      const list = byGroup.get(gid) ?? []
      list.push(n)
      byGroup.set(gid, list)
    } else ungrouped.push(n)
  }
  return {
    ungrouped,
    groups: sortGroups(groups).map((group) => ({ group, chats: byGroup.get(group.id) ?? [] }))
  }
}

export type DropPosition = 'before' | 'after'

/**
 * Move o grupo `draggedId` para antes/depois de `targetId` e renumera `sortOrder` (0..n-1).
 * Devolve a lista nova e só os grupos cujo `sortOrder` mudou (para `groups.update`).
 * Ids desconhecidos ou arrastar sobre si mesmo → nada muda.
 */
export function reorderGroups(
  groups: ChatGroup[],
  draggedId: string,
  targetId: string,
  position: DropPosition
): { groups: ChatGroup[]; changed: { id: string; sortOrder: number }[] } {
  const sorted = sortGroups(groups)
  const dragged = sorted.find((g) => g.id === draggedId)
  if (!dragged || draggedId === targetId || !sorted.some((g) => g.id === targetId))
    return { groups: sorted, changed: [] }
  const rest = sorted.filter((g) => g.id !== draggedId)
  const at = rest.findIndex((g) => g.id === targetId) + (position === 'after' ? 1 : 0)
  rest.splice(at, 0, dragged)
  const changed: { id: string; sortOrder: number }[] = []
  const next = rest.map((g, i) => {
    if (g.sortOrder === i) return g
    changed.push({ id: g.id, sortOrder: i })
    return { ...g, sortOrder: i }
  })
  return { groups: next, changed }
}

/** Sobe (-1) ou desce (+1) um grupo uma posição; alternativa de teclado ao arrastar. */
export function moveGroupBy(
  groups: ChatGroup[],
  id: string,
  delta: -1 | 1
): { groups: ChatGroup[]; changed: { id: string; sortOrder: number }[] } {
  const sorted = sortGroups(groups)
  const i = sorted.findIndex((g) => g.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= sorted.length) return { groups: sorted, changed: [] }
  return reorderGroups(sorted, id, sorted[j].id, delta > 0 ? 'after' : 'before')
}

/** Próximo `sortOrder` para um grupo novo (fim da lista). */
export function nextSortOrder(groups: ChatGroup[]): number {
  return groups.reduce((max, g) => Math.max(max, g.sortOrder + 1), 0)
}

/** Troca o grupo de um chat na lista de topo; chat ausente ou já no grupo → mesma lista. */
export function setChatGroup(top: Chat[], chatId: string, groupId: string | null): Chat[] {
  const c = top.find((x) => x.id === chatId)
  if (!c || c.groupId === groupId) return top
  return top.map((x) => (x.id === chatId ? { ...x, groupId } : x))
}

/** Chats que estavam no grupo excluído ficam sem grupo. */
export function ungroupChats(top: Chat[], groupId: string): Chat[] {
  return top.some((c) => c.groupId === groupId)
    ? top.map((c) => (c.groupId === groupId ? { ...c, groupId: null } : c))
    : top
}

// Arrastar e soltar (HTML5): tipos MIME próprios para distinguir chat de grupo.
export const DND_CHAT = 'application/x-justtocode-chat'
export const DND_GROUP = 'application/x-justtocode-group'

/** Metade superior do alvo → antes; inferior → depois. */
export function dropPosition(offsetY: number, height: number): DropPosition {
  return offsetY < height / 2 ? 'before' : 'after'
}
