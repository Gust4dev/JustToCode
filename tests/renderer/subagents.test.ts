import { describe, it, expect } from 'vitest'
import type { Chat, ToolCallRecord } from '@shared/domain'
import {
  applySubagentEvent,
  hydrateSubagents,
  matchSubagentChildren,
  taskArgs,
  type SubagentMap
} from '../../src/renderer/src/features/chat/subagents'

const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id,
  projectId: 'p1',
  parentChatId: 'parent',
  agentName: 'general',
  title: id,
  color: '#000',
  combo: 'c',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  ...over
})

const task = (id: string, agent: string | undefined, startedAt: number): ToolCallRecord => ({
  id,
  modelCallId: `m-${id}`,
  messageId: 'msg',
  chatId: 'parent',
  name: 'task',
  args: JSON.stringify({ ...(agent ? { agent } : {}), description: `d-${id}`, prompt: 'p' }),
  status: 'done',
  outputPreview: null,
  outputTruncated: false,
  startedAt,
  finishedAt: null
})

describe('applySubagentEvent', () => {
  it('started → rodando; finished → parado, mantendo o agente', () => {
    let m: SubagentMap = {}
    m = applySubagentEvent(
      m,
      {
        type: 'subagent_started',
        chatId: 'parent',
        childChatId: 'k1',
        agentName: 'rev',
        toolCallId: 't1'
      },
      'parent'
    )
    expect(m.t1).toEqual({ childChatId: 'k1', agentName: 'rev', running: true })
    m = applySubagentEvent(
      m,
      { type: 'subagent_finished', chatId: 'parent', childChatId: 'k1', toolCallId: 't1' },
      'parent'
    )
    expect(m.t1).toEqual({ childChatId: 'k1', agentName: 'rev', running: false })
  })

  it('ignora outros chats e outros eventos', () => {
    const m: SubagentMap = {}
    expect(
      applySubagentEvent(
        m,
        {
          type: 'subagent_started',
          chatId: 'x',
          childChatId: 'k',
          agentName: 'a',
          toolCallId: 't'
        },
        'parent'
      )
    ).toBe(m)
    expect(
      applySubagentEvent(m, { type: 'turn_finished', chatId: 'parent', requestId: 'r' }, 'parent')
    ).toBe(m)
  })
})

describe('matchSubagentChildren', () => {
  it('casa por agente e ordem; ignora tool calls que não são task', () => {
    const calls = [
      task('t2', 'rev', 20),
      task('t1', undefined, 10),
      task('t3', 'rev', 30),
      { ...task('x', 'rev', 5), name: 'shell' }
    ]
    const kids = [
      chat('kRev2', { agentName: 'rev', createdAt: 31, status: 'running' }),
      chat('kGen', { agentName: 'general', createdAt: 11 }),
      chat('kRev1', { agentName: 'rev', createdAt: 21 })
    ]
    const m = matchSubagentChildren(calls, kids)
    expect(m.t1.childChatId).toBe('kGen')
    expect(m.t2.childChatId).toBe('kRev1')
    expect(m.t3).toEqual({ childChatId: 'kRev2', agentName: 'rev', running: true })
    expect(m.x).toBeUndefined()
  })

  it('sem filho correspondente não inventa link', () => {
    expect(matchSubagentChildren([task('t1', 'rev', 1)], [])).toEqual({})
  })

  it('evento vence o casamento por lista', () => {
    const ev: SubagentMap = { t1: { childChatId: 'real', agentName: 'rev', running: true } }
    const matched: SubagentMap = {
      t1: { childChatId: 'guess', agentName: 'rev', running: false },
      t2: { childChatId: 'k2', agentName: 'rev', running: false }
    }
    const out = hydrateSubagents(ev, matched)
    expect(out.t1.childChatId).toBe('real')
    expect(out.t2.childChatId).toBe('k2')
  })
})

describe('taskArgs', () => {
  it('lê objeto ou JSON; agente padrão general', () => {
    expect(taskArgs({ agent: 'rev', description: 'olhar' })).toEqual({
      agent: 'rev',
      description: 'olhar'
    })
    expect(taskArgs('{"description":"x"}')).toEqual({ agent: 'general', description: 'x' })
    expect(taskArgs('lixo')).toEqual({ agent: 'general', description: '' })
  })
})
