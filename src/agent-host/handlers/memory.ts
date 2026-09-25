import type { HostParams, HostResult } from '@shared/api'
import { RpcError } from '@shared/rpc'
import type { HandlerModule } from '../context'
import { MemoryError, type MemoryService } from '../memory/memory'

/** Handlers `memory.undo` (desfaz o último save) e `memory.deleteByOrigin` (lote por terceiro). */
export const memoryHandlers =
  (memory: MemoryService): HandlerModule =>
  () => ({
    'memory.undo': ({ id }: HostParams<'memory.undo'>): HostResult<'memory.undo'> => {
      if (typeof id !== 'string' || !id) throw new RpcError('Id inválido', 'INVALID_PARAMS')
      try {
        memory.undo(id)
      } catch (e) {
        if (e instanceof MemoryError) throw new RpcError('Memória não encontrada', 'NOT_FOUND')
        throw e
      }
      return null
    },
    'memory.deleteByOrigin': ({
      thirdPartyId
    }: HostParams<'memory.deleteByOrigin'>): HostResult<'memory.deleteByOrigin'> => {
      if (typeof thirdPartyId !== 'string' || !thirdPartyId) {
        throw new RpcError('Id inválido', 'INVALID_PARAMS')
      }
      return { deleted: memory.deleteByOrigin(thirdPartyId) }
    }
  })
