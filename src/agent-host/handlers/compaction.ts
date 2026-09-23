import type { HostParams, HostResult } from '@shared/api'
import { RpcError } from '@shared/rpc'
import type { HandlerModule } from '../context'
import type { AgentEngine } from '../engine/agentEngine'
import type { CompactionRepo } from '../repo/compactions'
import type { MessageRepo } from '../repo/messages'
import { summaryText } from '../context/compaction'

/** Registrado a partir do container de serviços (`services/index.ts`). */
export function compactionHandlers(d: {
  engine: AgentEngine
  compactions: CompactionRepo
  messages: MessageRepo
}): HandlerModule {
  return () => ({
    'compaction.run': (p: HostParams<'compaction.run'>): Promise<HostResult<'compaction.run'>> =>
      d.engine.compact(p.chatId),
    'compaction.list': (p: HostParams<'compaction.list'>): HostResult<'compaction.list'> =>
      d.compactions.list(p.chatId),
    'compaction.get': (p: HostParams<'compaction.get'>): HostResult<'compaction.get'> => {
      const record = d.compactions.get(p.id)
      if (!record) throw new RpcError('Compactação não encontrada', 'NOT_FOUND')
      const summaryMessage = d.messages.get(record.summaryMessageId)
      const originals = d.messages
        .list(record.chatId, { includeCompacted: true })
        .filter(
          (m) =>
            m.compacted && m.kind !== 'summary' && m.seq >= record.fromSeq && m.seq <= record.toSeq
        )
      return {
        record,
        summary: summaryMessage ? summaryText(summaryMessage) : '',
        originals
      }
    }
  })
}
