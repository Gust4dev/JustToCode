import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import type { AgentEngine } from '../engine/agentEngine'

/** Registrado a partir do container de serviços (`services/index.ts`). */
export function engineHandlers(engine: AgentEngine): HandlerModule {
  return () => ({
    'engine.send': (p: HostParams<'engine.send'>): Promise<HostResult<'engine.send'>> =>
      engine.send(p.chatId, p.text ?? '', p.attachments ?? []),
    'engine.cancel': (p: HostParams<'engine.cancel'>): HostResult<'engine.cancel'> => {
      engine.cancel(p.chatId)
      return null
    },
    'engine.continue': (p: HostParams<'engine.continue'>): HostResult<'engine.continue'> => {
      engine.continue(p.chatId)
      return null
    },
    'context.get': (p: HostParams<'context.get'>): HostResult<'context.get'> =>
      engine.context(p.chatId)
  })
}
