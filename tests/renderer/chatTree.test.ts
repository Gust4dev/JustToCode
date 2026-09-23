import { describe, it, expect } from 'vitest'
import type { Chat } from '@shared/domain'
import {
  buildChatTree,
  chatInProject,
  findChatIn,
  removeFromChildren,
  upsertChild
} from '../../src/renderer/src/features/projects/chatTree'

const chat = (id: string, parentChatId: string | null = null, createdAt = 0): Chat => ({
  id,
  projectId: 'p1',
  parentChatId,
  agentName: parentChatId ? 'general' : null,
  title: id,
  color: '#000',
  combo: 'c',
  permissionMode: 'ask',
  status: 'idle',
  createdAt
})

describe('chatTree', () => {
  const top = [chat('b', null, 2), chat('a', null, 1)]
  const children = { a: [chat('a2', 'a', 5), chat('a1', 'a', 3)] }

  it('buildChatTree mantém a ordem do topo e ordena filhos por criação', () => {
    const tree = buildChatTree(top, children)
    expect(tree.map((n) => n.chat.id)).toEqual(['b', 'a'])
    expect(tree[0].children).toEqual([])
    expect(tree[1].children.map((c) => c.id)).toEqual(['a1', 'a2'])
  })

  it('findChatIn acha topo e filho', () => {
    expect(findChatIn({ p1: top }, children, 'a')?.id).toBe('a')
    expect(findChatIn({ p1: top }, children, 'a2')?.id).toBe('a2')
    expect(findChatIn({ p1: top }, children, 'zz')).toBeNull()
    expect(findChatIn({ p1: top }, children, null)).toBeNull()
  })

  it('chatInProject considera filhos de chats do projeto', () => {
    expect(chatInProject(top, children, 'a1')).toBe(true)
    expect(chatInProject(top, children, 'b')).toBe(true)
    expect(chatInProject(top, { zz: [chat('orfao', 'zz')] }, 'orfao')).toBe(false)
  })

  it('upsertChild insere e troca; chat sem pai não entra', () => {
    const added = upsertChild(children, chat('a3', 'a', 9))
    expect(added.a.map((c) => c.id)).toEqual(['a2', 'a1', 'a3'])
    const replaced = upsertChild(added, { ...chat('a1', 'a', 3), status: 'running' })
    expect(replaced.a.find((c) => c.id === 'a1')?.status).toBe('running')
    expect(upsertChild(children, chat('x'))).toBe(children)
  })

  it('removeFromChildren tira o filho e, se for pai, a lista dele', () => {
    expect(removeFromChildren(children, 'a1').a.map((c) => c.id)).toEqual(['a2'])
    expect(removeFromChildren(children, 'a').a).toBeUndefined()
  })
})
