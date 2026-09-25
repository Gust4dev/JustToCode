import type { AppConfig, Chat } from '@shared/domain'
import { RpcError } from '@shared/rpc'
import type { HostContext } from '../context'
import type { ChatRepo } from '../repo/chats'
import type { ChatGroupRepo } from '../repo/chatGroups'
import type { MessageRepo } from '../repo/messages'
import type { Summarizer } from '../context/summarizer'
import { SUMMARY_PREFIX, summarizerModels, summaryText } from '../context/compaction'

export interface ContinuationDeps {
  ctx: HostContext
  chats: ChatRepo
  groups: ChatGroupRepo
  messages: MessageRepo
  summarizer: Summarizer
  getConfig: () => AppConfig
}

export interface Continuation {
  /** Cria um chat novo que continua `chatId` a partir de um summary do original. */
  continueChat(chatId: string): Promise<Chat>
}

export const continuationTitle = (title: string): string => `Continuação: ${title}`

/** Modelos do summarizer: o do chat (settings) primeiro, depois a ordem padrão. */
function modelsFor(cfg: AppConfig, chat: Chat): string[] {
  const out: string[] = []
  for (const m of [chat.settings.summarizerModel, ...summarizerModels(cfg, chat.combo)]) {
    const v = m?.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

export function createContinuation(d: ContinuationDeps): Continuation {
  return {
    async continueChat(chatId) {
      const original = d.chats.get(chatId)
      if (!original) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
      if (original.parentChatId) {
        throw new RpcError('Subagentes não podem ser continuados', 'INVALID')
      }

      // Reusa o último summary vigente + as mensagens depois dele.
      const history = d.messages.list(chatId)
      const last = [...history].reverse().find((m) => m.kind === 'summary') ?? null
      const previous = last ? summaryText(last) : null
      const after = history.filter((m) => m.kind !== 'summary' && (!last || m.seq > last.seq))
      if (!previous && after.length === 0) {
        throw new RpcError('Chat vazio: nada para continuar', 'INVALID')
      }

      let text: string
      let model: string | undefined
      if (after.length === 0 && previous) {
        text = previous
        model = last?.modelUsed ?? undefined
      } else {
        const r = await d.summarizer.summarize({
          previous,
          messages: after,
          models: modelsFor(d.getConfig(), original)
        })
        text = r.text
        model = r.model
      }

      const commit = d.ctx.db.transaction(() => {
        const cur = d.chats.get(chatId)
        if (!cur) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
        let groupId = cur.groupId
        let movedOriginal: Chat | null = null
        if (!groupId) {
          groupId = d.groups.create(cur.projectId, cur.title).id
          movedOriginal = d.chats.update(cur.id, { groupId })
        }
        const created = d.chats.create({
          projectId: cur.projectId,
          title: continuationTitle(cur.title),
          color: d.chats.nextColor(cur.projectId),
          combo: cur.combo,
          permissionMode: cur.permissionMode,
          groupId,
          continuedFromChatId: cur.id,
          maxIterations: cur.maxIterations,
          tokenBudget: cur.tokenBudget,
          settings: cur.settings
        })
        d.messages.append(
          created.id,
          { role: 'user', content: SUMMARY_PREFIX + text },
          { kind: 'summary', ...(model ? { modelUsed: model } : {}) }
        )
        return { created, movedOriginal }
      })
      const { created, movedOriginal } = commit()
      if (movedOriginal) d.ctx.emit({ type: 'chat_updated', chat: movedOriginal })
      d.ctx.emit({ type: 'chat_updated', chat: created })
      return created
    }
  }
}
