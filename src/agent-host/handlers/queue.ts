import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import type { AgentEngine } from '../engine/agentEngine'

/** Fila de mensagens por chat + título gerado (dependem do engine). */
export function queueHandlers(engine: AgentEngine): HandlerModule {
  return () => ({
    'queue.get': (p: HostParams<'queue.get'>): HostResult<'queue.get'> =>
      engine.queue.get(p.chatId),
    'queue.remove': (p: HostParams<'queue.remove'>): HostResult<'queue.remove'> =>
      engine.queue.remove(p.id),
    'queue.edit': (p: HostParams<'queue.edit'>): HostResult<'queue.edit'> =>
      engine.queue.edit(p.id, p.text ?? ''),
    'queue.resume': (p: HostParams<'queue.resume'>): HostResult<'queue.resume'> =>
      engine.queue.resume(p.chatId),
    'chats.generateTitle': (
      p: HostParams<'chats.generateTitle'>
    ): Promise<HostResult<'chats.generateTitle'>> => engine.generateTitle(p.chatId)
  })
}
