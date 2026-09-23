import type { Chat, ToolCallRecord } from '@shared/domain'
import type { EngineEvent } from '@shared/events'
import { parseArgs } from './toolInfo'

// Estado puro dos subagentes de um chat pai: toolCallId da `task` → chat filho.

export interface SubagentLink {
  childChatId: string
  agentName: string
  running: boolean
}

export type SubagentMap = Record<string, SubagentLink>

export const TASK_TOOL = 'task'

/** Argumentos da ferramenta `task` (`{ agent, description, prompt }`). */
export function taskArgs(args: unknown): { agent: string; description: string } {
  const a = parseArgs(args)
  return {
    agent: typeof a.agent === 'string' && a.agent ? a.agent : 'general',
    description: typeof a.description === 'string' ? a.description : ''
  }
}

/** Aplica `subagent_started`/`subagent_finished` do chat pai `chatId`. */
export function applySubagentEvent(map: SubagentMap, e: EngineEvent, chatId: string): SubagentMap {
  if (e.type === 'subagent_started') {
    if (e.chatId !== chatId) return map
    return {
      ...map,
      [e.toolCallId]: { childChatId: e.childChatId, agentName: e.agentName, running: true }
    }
  }
  if (e.type === 'subagent_finished') {
    if (e.chatId !== chatId) return map
    const prev = map[e.toolCallId]
    return {
      ...map,
      [e.toolCallId]: {
        childChatId: e.childChatId,
        agentName: prev?.agentName ?? '',
        running: false
      }
    }
  }
  return map
}

const RUNNING = new Set<Chat['status']>(['running', 'waiting_approval'])

/**
 * Liga as tool calls `task` já gravadas aos chats filhos (`chats.children`) quando não há evento
 * (ex.: conversa reaberta). O chat filho não guarda o toolCallId: casa por agente, na ordem
 * (tool call por `startedAt`, filho por `createdAt`).
 */
export function matchSubagentChildren(toolCalls: ToolCallRecord[], children: Chat[]): SubagentMap {
  const tasks = toolCalls
    .filter((tc) => tc.name === TASK_TOOL)
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity))
  const pool = [...children].sort((a, b) => a.createdAt - b.createdAt)
  const used = new Set<string>()
  const out: SubagentMap = {}
  for (const tc of tasks) {
    const { agent } = taskArgs(tc.args)
    const child = pool.find((c) => !used.has(c.id) && (c.agentName ?? 'general') === agent)
    if (!child) continue
    used.add(child.id)
    out[tc.id] = {
      childChatId: child.id,
      agentName: child.agentName ?? agent,
      running: RUNNING.has(child.status)
    }
  }
  return out
}

/** Junta o casamento por lista com o que chegou por evento (evento vence). */
export function hydrateSubagents(map: SubagentMap, matched: SubagentMap): SubagentMap {
  return { ...matched, ...map }
}
