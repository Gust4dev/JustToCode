import { describe, it, expect } from 'vitest'
import { DEFAULT_CHAT_SETTINGS, type Chat, type ChatGroup } from '@shared/domain'
import {
  buildSidebarTree,
  dropPosition,
  moveGroupBy,
  nextSortOrder,
  reorderGroups,
  setChatGroup,
  sortGroups,
  ungroupChats
} from '../../src/renderer/src/features/projects/groupTree'

const chat = (
  id: string,
  groupId: string | null = null,
  parentChatId: string | null = null,
  createdAt = 0
): Chat => ({
  id,
  projectId: 'p1',
  parentChatId,
  agentName: parentChatId ? 'general' : null,
  title: id,
  color: '#000',
  combo: 'c',
  permissionMode: 'ask',
  status: 'idle',
  createdAt,
  groupId,
  continuedFromChatId: null,
  maxIterations: 50,
  tokenBudget: null,
  settings: { ...DEFAULT_CHAT_SETTINGS },
  lastReportedModel: null
})

const group = (id: string, sortOrder: number, createdAt = 0): ChatGroup => ({
  id,
  projectId: 'p1',
  name: id,
  sortOrder,
  collapsed: false,
  createdAt
})

const ids = (gs: ChatGroup[]): string[] => gs.map((g) => g.id)

describe('groupTree', () => {
  it('sortGroups ordena por sortOrder, depois criação', () => {
    expect(ids(sortGroups([group('b', 1), group('c', 0, 5), group('a', 0, 1)]))).toEqual([
      'a',
      'c',
      'b'
    ])
  })

  it('buildSidebarTree: sem grupo no topo, grupos em ordem, filhos aninhados preservados', () => {
    const top = [chat('x', 'g2'), chat('y', null), chat('z', 'g1'), chat('w', 'sumido')]
    const children = { x: [chat('x2', null, 'x', 5), chat('x1', null, 'x', 3)] }
    const tree = buildSidebarTree([group('g2', 1), group('g1', 0), group('g3', 2)], top, children)
    expect(tree.ungrouped.map((n) => n.chat.id)).toEqual(['y', 'w'])
    expect(tree.groups.map((g) => g.group.id)).toEqual(['g1', 'g2', 'g3'])
    expect(tree.groups[0].chats.map((n) => n.chat.id)).toEqual(['z'])
    expect(tree.groups[1].chats[0].children.map((c) => c.id)).toEqual(['x1', 'x2'])
    expect(tree.groups[2].chats).toEqual([])
  })

  it('reorderGroups move antes/depois e devolve só os alterados', () => {
    const gs = [group('a', 0), group('b', 1), group('c', 2)]
    const r1 = reorderGroups(gs, 'c', 'a', 'before')
    expect(ids(r1.groups)).toEqual(['c', 'a', 'b'])
    expect(r1.changed).toEqual([
      { id: 'c', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
      { id: 'b', sortOrder: 2 }
    ])
    const r2 = reorderGroups(gs, 'a', 'b', 'after')
    expect(ids(r2.groups)).toEqual(['b', 'a', 'c'])
    expect(r2.changed).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 }
    ])
  })

  it('reorderGroups ignora arrastar sobre si e ids desconhecidos', () => {
    const gs = [group('a', 0), group('b', 1)]
    expect(reorderGroups(gs, 'a', 'a', 'after').changed).toEqual([])
    expect(reorderGroups(gs, 'zz', 'a', 'after').changed).toEqual([])
    expect(reorderGroups(gs, 'a', 'zz', 'after').changed).toEqual([])
  })

  it('reorderGroups normaliza sortOrders com buracos', () => {
    const r = reorderGroups([group('a', 10), group('b', 20)], 'b', 'a', 'before')
    expect(r.groups.map((g) => [g.id, g.sortOrder])).toEqual([
      ['b', 0],
      ['a', 1]
    ])
  })

  it('moveGroupBy sobe/desce e para nas bordas', () => {
    const gs = [group('a', 0), group('b', 1), group('c', 2)]
    expect(ids(moveGroupBy(gs, 'b', -1).groups)).toEqual(['b', 'a', 'c'])
    expect(ids(moveGroupBy(gs, 'b', 1).groups)).toEqual(['a', 'c', 'b'])
    expect(moveGroupBy(gs, 'a', -1).changed).toEqual([])
    expect(moveGroupBy(gs, 'c', 1).changed).toEqual([])
  })

  it('nextSortOrder vai para o fim', () => {
    expect(nextSortOrder([])).toBe(0)
    expect(nextSortOrder([group('a', 3), group('b', 1)])).toBe(4)
  })

  it('setChatGroup e ungroupChats', () => {
    const top = [chat('a', 'g1'), chat('b', null)]
    expect(setChatGroup(top, 'b', 'g1').map((c) => c.groupId)).toEqual(['g1', 'g1'])
    expect(setChatGroup(top, 'a', 'g1')).toBe(top)
    expect(setChatGroup(top, 'zz', 'g1')).toBe(top)
    expect(ungroupChats(top, 'g1').map((c) => c.groupId)).toEqual([null, null])
    expect(ungroupChats(top, 'g9')).toBe(top)
  })

  it('dropPosition divide o alvo ao meio', () => {
    expect(dropPosition(2, 20)).toBe('before')
    expect(dropPosition(15, 20)).toBe('after')
  })
})
