import type { AppConfig } from '@shared/domain'
import type { HostParams, HostResult } from '@shared/api'
import { RpcError } from '@shared/rpc'
import type { HandlerModule } from '../context'
import type { ChatRepo } from '../repo/chats'
import type { ModelClient } from '../model/types'
import { parseRule } from '../engine/ruleParse'

export interface RuleHandlerDeps {
  model: ModelClient
  chats: ChatRepo
  getConfig: () => AppConfig
}

/** `rules.parse`: separa regra e ajustes do chat (`/regra`). Salvar/aplicar fica com a UI. */
export const ruleHandlers =
  (d: RuleHandlerDeps): HandlerModule =>
  () => ({
    'rules.parse': async (p: HostParams<'rules.parse'>): Promise<HostResult<'rules.parse'>> => {
      const chat = d.chats.get(p.chatId)
      if (!chat) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
      if (typeof p.text !== 'string') throw new RpcError('Texto inválido', 'INVALID_PARAMS')
      return parseRule({ model: d.model, getConfig: d.getConfig }, chat, p.text)
    }
  })
