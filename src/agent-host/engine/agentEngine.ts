import type { AttachmentUpload } from '@shared/api'
import type {
  ChatMessage,
  ChatStatus,
  CompactionRecord,
  ContentPart,
  ContextState,
  StoredMessage
} from '@shared/domain'
import { RpcError } from '@shared/rpc'
import { estimateMessage } from '../context/tokenizer'
import { compactChat, summarizerModels } from '../context/compaction'
import { agentPrompt, filterTools, findAgent, availableAgents } from '../ecosystem/agents'
import { TASK_TOOL, type SubagentRequest } from '../tools/task'
import type { ToolResult } from '../tools/types'
import {
  compactionDeps,
  estimateHistory,
  runTurn,
  systemFor,
  type EngineDeps,
  type EngineState,
  type WindowInfo
} from './turn'

export interface AgentEngine {
  /** Resolve depois de gravar a mensagem do usuário; o turno segue em background. */
  send(
    chatId: string,
    text: string,
    attachments: AttachmentUpload[]
  ): Promise<{ messageId: string }>
  cancel(chatId: string): void
  context(chatId: string): ContextState
  /** Compactação manual; `CHAT_BUSY` se o chat estiver rodando, `NOTHING_TO_COMPACT` se não há o que resumir. */
  compact(chatId: string): Promise<CompactionRecord>
  isRunning(chatId: string): boolean
  /** Roda um subagente (chat filho) até o fim e devolve o último texto dele (ferramenta `task`). */
  runSubagent(req: SubagentRequest): Promise<ToolResult>
}

export type { EngineDeps }

const TERMINAL: ChatStatus[] = ['idle', 'error', 'interrupted']
const MAX_TEXT_ATTACHMENT_CHARS = 200_000
const MODELS_REFETCH_MS = 60_000
/** Quanto o turno espera pela lista de modelos antes de seguir sem a janela. */
const MODELS_WAIT_MS = 3000

/** Dimensões a partir do cabeçalho png/jpeg/gif; null quando não reconhece. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length >= 10 && buf.subarray(0, 4).toString('latin1') === 'GIF8') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2
          continue
        }
        const len = buf.readUInt16BE(i + 2)
        const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        i += 2 + len
      }
    }
  } catch {
    // cabeçalho truncado
  }
  return null
}

export function createAgentEngine(d: EngineDeps): AgentEngine {
  const { ctx } = d
  const running = new Map<string, AbortController>()
  const reportedModels = new Map<string, string | null>()
  const contexts = new Map<string, ContextState>()
  const windows = new Map<string, WindowInfo>()
  const models: {
    key: string | null
    failedAt: Map<string, number>
    inflight: Map<string, Promise<void>>
  } = { key: null, failedAt: new Map(), inflight: new Map() }
  const resetWindows = (): void => {
    d.resolver.invalidate()
    windows.clear()
    models.failedAt.clear()
  }
  // Config nova (URL/chave do router, banco do 9router) invalida o cache de janelas.
  d.onConfig?.(() => {
    models.key = null
    resetWindows()
  })

  const state: EngineState = {
    setStatus(chatId, status) {
      if (TERMINAL.includes(status)) running.delete(chatId)
      if (!d.chats.get(chatId)) return
      d.chats.setStatus(chatId, status)
      ctx.emit({ type: 'chat_status_changed', chatId, status })
    },
    lastReportedModel(chatId) {
      if (!reportedModels.has(chatId)) {
        const last = d.requests
          .list(chatId)
          .filter((r) => r.modelReported)
          .pop()
        reportedModels.set(chatId, last?.modelReported ?? null)
      }
      return reportedModels.get(chatId) ?? null
    },
    setReportedModel(chatId, model) {
      reportedModels.set(chatId, model)
    },
    windowFor(model) {
      return windows.get(model) ?? { window: null, limitingModel: null }
    },
    async ensureModels(model) {
      const cfg = d.getConfig()
      const key = `${cfg.routerBaseUrl}
${cfg.routerApiKey}
${cfg.routerDbPath}`
      if (key !== models.key) {
        if (models.key !== null) resetWindows()
        models.key = key
      }
      // Router fora do ar: tenta de novo no máximo 1×/min por modelo.
      const failed = models.failedAt.get(model)
      if (failed !== undefined && Date.now() - failed < MODELS_REFETCH_MS) return
      let inflight = models.inflight.get(model)
      if (!inflight) {
        inflight = d.resolver
          .effectiveWindow(model)
          .then((w) => {
            if (models.key === key) windows.set(model, w)
            models.failedAt.delete(model)
          })
          .catch(() => {
            models.failedAt.set(model, Date.now())
          })
          .finally(() => {
            models.inflight.delete(model)
          })
        models.inflight.set(model, inflight)
      }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        inflight,
        new Promise<void>((r) => (timer = setTimeout(r, MODELS_WAIT_MS)))
      ])
      clearTimeout(timer)
    },
    setContext(chatId, c) {
      contexts.set(chatId, c)
    },
    lastContext(chatId) {
      return contexts.get(chatId) ?? null
    }
  }

  const buildUserMessage = (
    text: string,
    attachments: AttachmentUpload[]
  ): {
    message: ChatMessage
    metas: {
      kind: 'image' | 'file'
      name: string
      blobHash: string
      mime: string
      bytes: number
      width: number | null
      height: number | null
    }[]
  } => {
    const metas: ReturnType<typeof buildUserMessage>['metas'] = []
    const images: ContentPart[] = []
    const files: ContentPart[] = []
    for (const a of attachments) {
      const buf = Buffer.from(a.dataBase64, 'base64')
      const blobHash = ctx.blobs.put(buf)
      const isImage = a.mime.startsWith('image/')
      const size = isImage ? imageSize(buf) : null
      metas.push({
        kind: isImage ? 'image' : 'file',
        name: a.name,
        blobHash,
        mime: a.mime,
        bytes: buf.length,
        width: size?.width ?? null,
        height: size?.height ?? null
      })
      if (isImage) {
        images.push({ type: 'image_url', image_url: { url: `blob:${blobHash}` } })
      } else if (!buf.subarray(0, 8192).includes(0)) {
        let body = buf.toString('utf8')
        if (body.length > MAX_TEXT_ATTACHMENT_CHARS) {
          body = body.slice(0, MAX_TEXT_ATTACHMENT_CHARS) + '\n[attachment truncated]'
        }
        files.push({
          type: 'text',
          text: `<attached_file name="${a.name}">\n${body}\n</attached_file>`
        })
      } else {
        files.push({ type: 'text', text: `[binary attachment omitted: ${a.name}]` })
      }
    }
    if (!images.length && !files.length) return { message: { role: 'user', content: text }, metas }
    const parts: ContentPart[] = []
    if (text) parts.push({ type: 'text', text })
    parts.push(...files, ...images)
    return { message: { role: 'user', content: parts }, metas }
  }

  async function runSubagent(req: SubagentRequest): Promise<ToolResult> {
    const parent = d.chats.get(req.parentChatId)
    if (!parent) return { content: 'Parent chat not found', isError: true }
    // Profundidade máxima 1: um subagente não dispara outro.
    if (parent.parentChatId) {
      return { content: 'Subagents cannot launch other subagents.', isError: true }
    }
    const project = d.projects.get(parent.projectId)
    if (!project) return { content: 'Project not found', isError: true }
    if (req.signal.aborted) return { content: 'Cancelled by user.', isError: true }
    const roots = d.getConfig().agentRoots ?? []
    const def = findAgent(project.path, roots, req.agent)
    if (!def) {
      const names = availableAgents(project.path, roots).map((a) => a.name)
      return {
        content: `Unknown agent: ${req.agent}. Available agents: ${names.join(', ')}.`,
        isError: true
      }
    }

    const child = d.chats.create({
      projectId: parent.projectId,
      parentChatId: parent.id,
      agentName: def.name,
      title: req.description,
      color: parent.color,
      combo: def.combo || parent.combo,
      permissionMode: parent.permissionMode
    })
    const controller = new AbortController()
    running.set(child.id, controller)
    // Cancelar o pai (ou a tool call `task`) cancela o filho.
    const onAbort = (): void => {
      controller.abort()
      d.gate.cancelChat(child.id)
    }
    req.signal.addEventListener('abort', onAbort, { once: true })
    ctx.emit({
      type: 'subagent_started',
      chatId: parent.id,
      childChatId: child.id,
      agentName: def.name,
      toolCallId: req.toolCallId
    })

    let lastError: string | null = null
    const childDeps: EngineDeps = {
      ...d,
      ctx: {
        ...ctx,
        emit: (e) => {
          if (e.type === 'turn_error' && e.chatId === child.id) lastError = e.message
          ctx.emit(e)
        }
      }
    }
    try {
      const message = { role: 'user' as const, content: req.prompt }
      const stored = d.messages.append(child.id, message, { tokenEst: estimateMessage(message) })
      ctx.emit({ type: 'message_added', chatId: child.id, message: stored })
      state.setStatus(child.id, 'running')
      const tools = filterTools(
        d.tools.filter((t) => t.name !== TASK_TOOL),
        def.tools
      )
      await runTurn(childDeps, state, child.id, controller.signal, {
        tools: [...tools, d.readToolOutput],
        subagent: { subagent: true, agentPrompt: agentPrompt(def) },
        attributeTo: parent.id
      })
      if (controller.signal.aborted) return { content: 'Cancelled by user.', isError: true }
      if (lastError) return { content: `Subagent failed: ${lastError}`, isError: true }
      const last = d.messages
        .list(child.id)
        .filter((m) => m.message.role === 'assistant')
        .map((m) => m.message.content)
        .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        .pop()
      return { content: last ?? '(the subagent finished without a final message)' }
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true }
    } finally {
      req.signal.removeEventListener('abort', onAbort)
      if (running.get(child.id) === controller) running.delete(child.id)
      if (d.chats.get(child.id)?.status === 'running') state.setStatus(child.id, 'idle')
      ctx.emit({
        type: 'subagent_finished',
        chatId: parent.id,
        childChatId: child.id,
        toolCallId: req.toolCallId
      })
    }
  }

  return {
    runSubagent,

    async send(chatId, text, attachments) {
      if (running.has(chatId)) throw new RpcError('Chat ocupado', 'CHAT_BUSY')
      const chat = d.chats.get(chatId)
      if (!chat) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
      if (!d.projects.get(chat.projectId)) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      const list = attachments ?? []
      if (!text.trim() && list.length === 0) throw new RpcError('Mensagem vazia', 'EMPTY_MESSAGE')

      const controller = new AbortController()
      running.set(chatId, controller)
      let messageId: string
      try {
        const { message, metas } = buildUserMessage(text, list)
        const stored = d.messages.append(chatId, message, { tokenEst: estimateMessage(message) })
        for (const m of metas) stored.attachments.push(d.messages.addAttachment(stored.id, m))
        messageId = stored.id
        ctx.emit({ type: 'message_added', chatId, message: stored })
        state.setStatus(chatId, 'running')
      } catch (e) {
        running.delete(chatId)
        throw e
      }

      void runTurn(d, state, chatId, controller.signal).finally(() => {
        if (running.get(chatId) === controller) {
          running.delete(chatId)
          if (d.chats.get(chatId)?.status === 'running') state.setStatus(chatId, 'idle')
        }
      })
      return { messageId }
    },

    cancel(chatId) {
      const controller = running.get(chatId)
      if (!controller) return
      controller.abort()
      d.gate.cancelChat(chatId)
    },

    context(chatId) {
      const cached = contexts.get(chatId)
      if (cached) return cached
      const chat = d.chats.get(chatId)
      if (!chat) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
      const project = d.projects.get(chat.projectId)
      if (!project) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      const model = chat.combo || d.getConfig().defaultCombo
      const estTokens = estimateHistory(
        model,
        systemFor(project, d.getConfig()),
        [...d.tools, d.readToolOutput],
        d.messages.list(chatId)
      )
      const last = d.requests
        .list(chatId)
        .filter((r) => r.promptTokens !== null)
        .pop()
      const win = state.windowFor(model)
      return {
        estTokens,
        reportedTokens: last ? (last.promptTokens ?? 0) + (last.completionTokens ?? 0) : null,
        effectiveWindow: win.window,
        limitingModel: win.window !== null ? win.limitingModel : null
      }
    },

    async compact(chatId) {
      if (running.has(chatId)) throw new RpcError('Chat ocupado', 'CHAT_BUSY')
      const chat = d.chats.get(chatId)
      if (!chat) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
      const project = d.projects.get(chat.projectId)
      if (!project) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      const cfg = d.getConfig()
      const model = chat.combo || cfg.defaultCombo
      const system = systemFor(project, cfg)
      const tools = [...d.tools, d.readToolOutput]
      // Reserva o chat: `send` responde CHAT_BUSY e `cancel` aborta o resumo.
      const controller = new AbortController()
      running.set(chatId, controller)
      try {
        const record = await compactChat(compactionDeps(d), {
          chatId,
          trigger: 'manual',
          keepRecent: cfg.keepRecentMessages,
          models: summarizerModels(cfg, model),
          estimate: (h: StoredMessage[]) => estimateHistory(model, system, tools, h),
          signal: controller.signal
        })
        if (!record) throw new RpcError('Nada para compactar ainda', 'NOTHING_TO_COMPACT')
        // O contexto em cache ficou velho.
        contexts.delete(chatId)
        return record
      } finally {
        if (running.get(chatId) === controller) running.delete(chatId)
      }
    },

    isRunning(chatId) {
      return running.has(chatId)
    }
  }
}
