import { RpcError } from '@shared/rpc'
import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import { getConfig } from '../config'
import { ProjectRepo } from '../repo/projects'
import { ChatRepo } from '../repo/chats'
import { MessageRepo } from '../repo/messages'
import { ToolCallRepo } from '../repo/toolCalls'
import { RequestRepo } from '../repo/requests'

export const chatHandlers: HandlerModule = (ctx) => {
  const projects = new ProjectRepo(ctx.db)
  const chats = new ChatRepo(ctx.db)
  const messages = new MessageRepo(ctx.db)
  const toolCalls = new ToolCallRepo(ctx.db)
  const requests = new RequestRepo(ctx.db)

  const requireChat = (id: string): void => {
    if (!chats.get(id)) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
  }

  return {
    'chats.list': ({ projectId }: HostParams<'chats.list'>): HostResult<'chats.list'> =>
      chats.listByProject(projectId),

    'chats.children': ({ chatId }: HostParams<'chats.children'>): HostResult<'chats.children'> => {
      requireChat(chatId)
      return chats.children(chatId)
    },

    'chats.create': (p: HostParams<'chats.create'>): HostResult<'chats.create'> => {
      if (!projects.get(p.projectId)) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      return chats.create({
        projectId: p.projectId,
        title: p.title?.trim() || 'Novo chat',
        combo: p.combo ?? getConfig().defaultCombo,
        color: chats.nextColor(p.projectId)
      })
    },

    'chats.update': ({ id, ...patch }: HostParams<'chats.update'>): HostResult<'chats.update'> => {
      requireChat(id)
      return chats.update(id, patch)
    },

    'chats.delete': ({ id }: HostParams<'chats.delete'>): HostResult<'chats.delete'> => {
      chats.remove(id)
      return null
    },

    // A UI mostra o histórico inteiro (compactadas esmaecidas). O engine lê o repo direto,
    // sem as compactadas, então o request ao modelo não muda.
    'messages.list': ({ chatId }: HostParams<'messages.list'>): HostResult<'messages.list'> =>
      messages.list(chatId, { includeCompacted: true }),

    'toolCalls.list': ({ chatId }: HostParams<'toolCalls.list'>): HostResult<'toolCalls.list'> =>
      toolCalls.listByChat(chatId),

    'toolCalls.output': ({
      id
    }: HostParams<'toolCalls.output'>): HostResult<'toolCalls.output'> => {
      const tc = toolCalls.get(id)
      if (!tc) throw new RpcError('Chamada de ferramenta não encontrada', 'NOT_FOUND')
      const blob = tc.outputBlobHash ? ctx.blobs.get(tc.outputBlobHash) : null
      return { text: blob ? blob.toString('utf8') : (tc.outputPreview ?? '') }
    },

    'requests.list': ({ chatId }: HostParams<'requests.list'>): HostResult<'requests.list'> =>
      requests.list(chatId),

    'requests.payload': ({
      id
    }: HostParams<'requests.payload'>): HostResult<'requests.payload'> => {
      const r = requests.get(id)
      if (!r) throw new RpcError('Request não encontrado', 'NOT_FOUND')
      const blob = ctx.blobs.get(r.payloadBlobHash)
      if (!blob) throw new RpcError('Payload não encontrado', 'NOT_FOUND')
      return { json: blob.toString('utf8') }
    }
  }
}
