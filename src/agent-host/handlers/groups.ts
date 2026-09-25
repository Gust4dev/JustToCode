import { RpcError } from '@shared/rpc'
import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import { ProjectRepo } from '../repo/projects'
import { ChatGroupRepo } from '../repo/chatGroups'
import type { Continuation } from '../services/continuation'

export const groupHandlers: HandlerModule = (ctx) => {
  const projects = new ProjectRepo(ctx.db)
  const groups = new ChatGroupRepo(ctx.db)

  const requireGroup = (id: string): void => {
    if (!groups.get(id)) throw new RpcError('Grupo não encontrado', 'NOT_FOUND')
  }

  return {
    'groups.list': ({ projectId }: HostParams<'groups.list'>): HostResult<'groups.list'> =>
      groups.list(projectId),

    'groups.create': ({
      projectId,
      name
    }: HostParams<'groups.create'>): HostResult<'groups.create'> => {
      if (!projects.get(projectId)) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      const n = name?.trim()
      if (!n) throw new RpcError('Nome do grupo vazio', 'INVALID')
      return groups.create(projectId, n)
    },

    'groups.update': ({
      id,
      ...patch
    }: HostParams<'groups.update'>): HostResult<'groups.update'> => {
      requireGroup(id)
      if (patch.name !== undefined) {
        const n = patch.name.trim()
        if (!n) throw new RpcError('Nome do grupo vazio', 'INVALID')
        patch.name = n
      }
      return groups.update(id, patch)
    },

    'groups.delete': ({ id }: HostParams<'groups.delete'>): HostResult<'groups.delete'> => {
      groups.remove(id)
      return null
    }
  }
}

/** `chats.continue` depende do summarizer (container de serviços). */
export function continuationHandlers(continuation: Continuation): HandlerModule {
  return () => ({
    'chats.continue': ({
      chatId
    }: HostParams<'chats.continue'>): Promise<HostResult<'chats.continue'>> =>
      continuation.continueChat(chatId)
  })
}
