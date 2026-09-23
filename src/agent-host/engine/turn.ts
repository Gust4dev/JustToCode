import type {
  AppConfig,
  ChatMessage,
  StoredMessage,
  ChatStatus,
  CompactionRecord,
  ContentPart,
  ContextState,
  Project,
  ToolCallRecord,
  ToolCallSpec,
  ToolCallStatus
} from '@shared/domain'
import type { HostContext } from '../context'
import type { ProjectRepo } from '../repo/projects'
import type { ChatRepo } from '../repo/chats'
import type { MessageRepo } from '../repo/messages'
import type { RequestRepo } from '../repo/requests'
import type { ToolCallRepo } from '../repo/toolCalls'
import type { ModelClient, ChatRequest } from '../model/types'
import { toModelError, type ModelError } from '../model/errors'
import type { Tool, ToolContext, ToolResult } from '../tools/types'
import type { ChangeCapture, PermissionGate } from '../services/types'
import { estimateMessage, estimateMessages, estimateText } from '../context/tokenizer'
import type { CompactionRepo } from '../repo/compactions'
import type { ComboResolver } from '../context/comboResolver'
import type { Summarizer } from '../context/summarizer'
import {
  compactChat,
  ensureFits,
  summarizerModels,
  type CompactionDeps
} from '../context/compaction'
import { TOOL_IMAGES_TEXT } from '../context/select'
import { activeHistory, buildRequest, historyMessages, toRequestTool } from './buildRequest'
import { buildSystemPrompt } from './systemPrompt'
import { loadInstructions } from '../ecosystem/instructions'
import { discoverSkills } from '../ecosystem/skills'
import { discoverAgents } from '../ecosystem/agents'
import { TASK_TOOL } from '../tools/task'
import { capToolOutput, summarizeToolOutput } from './toolOutput'
import { resolveInside } from '../tools/pathGuard'

/** Caminho alvo (relativo, com '/') de uma ferramenta `edit`, para a checagem de colisão no gate. */
function editTarget(root: string, args: unknown): string | undefined {
  const path = (args as { path?: unknown } | null)?.path
  if (typeof path !== 'string' || !path) return undefined
  try {
    return resolveInside(root, path).rel
  } catch {
    return undefined
  }
}

export const MAX_ITERATIONS = 50
export const DEFAULT_RETRY_DELAYS_MS = [1000, 3000]
const PREVIEW_CHARS = 4000
export const DENIED_RESULT = 'User denied this action.'
export const CANCELLED_RESULT = 'Cancelled by user.'
export const AUTH_MESSAGE = 'Configure a chave do 9router nas configurações'

export interface EngineDeps {
  ctx: HostContext
  projects: ProjectRepo
  chats: ChatRepo
  messages: MessageRepo
  requests: RequestRepo
  toolCalls: ToolCallRepo
  model: ModelClient
  tools: Tool[]
  gate: PermissionGate
  capture: ChangeCapture
  getConfig: () => AppConfig
  readToolOutput: Tool
  /** Janela efetiva por combo (mínimo dos membros). */
  resolver: ComboResolver
  compactions: CompactionRepo
  summarizer: Summarizer
  /** Esperas entre novas tentativas de erros `retryable` (padrão 1 s, 3 s). */
  retryDelaysMs?: number[]
  /** Assina mudanças de config (invalida o cache de modelos/janelas). */
  onConfig?: (listener: () => void) => unknown
}

/** Estado compartilhado entre turnos, mantido pelo engine. */
export interface EngineState {
  setStatus(chatId: string, status: ChatStatus): void
  lastReportedModel(chatId: string): string | null
  setReportedModel(chatId: string, model: string): void
  /** Última janela efetiva conhecida do modelo/combo (via ComboResolver). */
  windowFor(model: string): WindowInfo
  /** Atualiza a janela via ComboResolver (invalida se a config do router mudou; espera no máx. alguns segundos). */
  ensureModels(model: string): Promise<void>
  setContext(chatId: string, c: ContextState): void
  lastContext(chatId: string): ContextState | null
}

export interface WindowInfo {
  window: number | null
  limitingModel: string | null
}

export function shellLabel(pref: AppConfig['shell']): string {
  if (pref === 'pwsh') return 'PowerShell 7 (pwsh)'
  if (pref === 'powershell') return 'Windows PowerShell (powershell.exe)'
  return 'PowerShell (pwsh if available, otherwise powershell.exe)'
}

export interface SystemOptions {
  /** Chat filho: sem a seção `# Subagents` e com as instruções do agente. */
  subagent?: boolean
  agentPrompt?: string
}

export function systemFor(project: Project, cfg: AppConfig, o: SystemOptions = {}): string {
  // Instruções e skills do usuário: somente leitura, com cache por mtime; falha nunca derruba o turno.
  let instructions = ''
  let skills: { name: string; description: string }[] = []
  try {
    instructions = loadInstructions(project.path, cfg.instructionFiles ?? []).text
  } catch {
    instructions = ''
  }
  try {
    skills = discoverSkills(project.path, cfg.skillRoots ?? [], cfg.pluginRoots ?? [])
  } catch {
    skills = []
  }
  let subagents: { name: string; description: string }[] = []
  if (!o.subagent) {
    try {
      subagents = discoverAgents(project.path, cfg.agentRoots ?? [])
    } catch {
      subagents = []
    }
  }
  return buildSystemPrompt({
    projectRoot: project.path,
    shell: shellLabel(cfg.shell),
    date: new Date().toISOString().slice(0, 10),
    instructions,
    skills,
    subagents,
    agentPrompt: o.agentPrompt
  })
}

export function estimateRequest(req: ChatRequest): number {
  return (
    estimateMessages(req.messages) +
    (req.tools.length ? estimateText(JSON.stringify(req.tools)) : 0)
  )
}

/** Estimativa do request que o histórico geraria (mesma ordem do buildRequest, sem resolver imagens). */
export function estimateHistory(
  model: string,
  system: string,
  tools: Tool[],
  history: StoredMessage[]
): number {
  return estimateRequest({
    model,
    messages: [{ role: 'system', content: system }, ...historyMessages(activeHistory(history))],
    tools: tools.map(toRequestTool)
  })
}

export function compactionDeps(d: EngineDeps): CompactionDeps {
  return {
    ctx: d.ctx,
    messages: d.messages,
    compactions: d.compactions,
    summarizer: d.summarizer
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

type StreamOutcome =
  | {
      kind: 'ok' | 'cancelled'
      requestId: string
      text: string
      reasoning: string
      calls: ToolCallSpec[]
      reported: string | null
    }
  | { kind: 'error'; requestId: string; error: ModelError }

interface Prepared {
  spec: ToolCallSpec
  record: ToolCallRecord
  tool: Tool | null
  args: unknown
  error: string | null
}

interface Outcome {
  content: string
  isError: boolean
  status: ToolCallStatus
  images: { mime: string; blobHash: string }[]
}

/** Opções do turno de um subagente (chat filho). */
export interface TurnOptions {
  /** Ferramentas do turno (padrão: `d.tools` + `read_tool_output`). */
  tools?: Tool[]
  /** Instruções extras do agente no system prompt (e sem a seção `# Subagents`). */
  subagent?: SystemOptions
  /** Chat que recebe a atribuição das mudanças (o pai); o `toolCallId` continua o do filho. */
  attributeTo?: string
}

/** Captura que grava as mudanças em nome de outro chat (subagente → pai). */
function attributedCapture(capture: ChangeCapture, chatId: string): ChangeCapture {
  return {
    recordToolWrite: (m, rel, before, after) =>
      capture.recordToolWrite({ ...m, chatId }, rel, before, after),
    withCommand: (m, fn) => capture.withCommand({ ...m, chatId }, fn)
  }
}

export async function runTurn(
  d: EngineDeps,
  s: EngineState,
  chatId: string,
  signal: AbortSignal,
  opts: TurnOptions = {}
): Promise<void> {
  const { ctx } = d
  const allTools = opts.tools ?? [...d.tools, d.readToolOutput]
  const capture = opts.attributeTo ? attributedCapture(d.capture, opts.attributeTo) : d.capture
  const byName = new Map(allTools.map((t) => [t.name, t]))
  const retryDelays = d.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS

  const fail = (message: string, code?: string): void => {
    s.setStatus(chatId, 'error')
    ctx.emit({ type: 'turn_error', chatId, message, ...(code ? { code } : {}) })
  }
  const finishCancelled = (): void => {
    s.setStatus(chatId, 'idle')
    ctx.emit({ type: 'turn_error', chatId, message: 'Cancelado pelo usuário', code: 'CANCELLED' })
  }

  async function stream(
    req: ChatRequest,
    estTokens: number,
    win: WindowInfo
  ): Promise<StreamOutcome> {
    const window = win.window
    const payloadBlobHash = ctx.blobs.put(JSON.stringify(req))
    for (let attempt = 0; ; attempt++) {
      const rec = d.requests.start({
        chatId,
        payloadBlobHash,
        modelRequested: req.model,
        estTokens,
        effectiveWindow: window
      })
      ctx.emit({ type: 'turn_started', chatId, requestId: rec.id, model: req.model })
      let text = ''
      let reasoning = ''
      let calls: ToolCallSpec[] = []
      let reported: string | null = null
      let usage: { promptTokens: number; completionTokens: number } | null = null
      let emitted = false
      try {
        for await (const ev of d.model.stream(req, signal)) {
          if (ev.type === 'text_delta') {
            emitted = true
            text += ev.delta
            ctx.emit({ type: 'text_delta', chatId, requestId: rec.id, delta: ev.delta })
          } else if (ev.type === 'reasoning_delta') {
            emitted = true
            reasoning += ev.delta
            ctx.emit({ type: 'reasoning_delta', chatId, requestId: rec.id, delta: ev.delta })
          } else if (ev.type === 'tool_calls') {
            calls = ev.calls
          } else if (ev.type === 'usage') {
            usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens }
          } else if (ev.type === 'model_reported') {
            reported = ev.model
            const prev = s.lastReportedModel(chatId)
            if (prev !== ev.model) {
              s.setReportedModel(chatId, ev.model)
              if (prev !== null) {
                ctx.emit({ type: 'provider_switched', chatId, from: prev, to: ev.model })
              }
            }
          }
        }
      } catch (e) {
        const err = toModelError(e)
        d.requests.finish(rec.id, { modelReported: reported, error: err.message })
        if (signal.aborted) {
          return { kind: 'cancelled', requestId: rec.id, text, reasoning, calls: [], reported }
        }
        if (err.o.retryable && !emitted && attempt < retryDelays.length) {
          await sleep(retryDelays[attempt], signal)
          if (signal.aborted) {
            return { kind: 'cancelled', requestId: rec.id, text, reasoning, calls: [], reported }
          }
          continue
        }
        return { kind: 'error', requestId: rec.id, error: err }
      }
      d.requests.finish(rec.id, {
        modelReported: reported,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        error: signal.aborted ? 'cancelled' : null
      })
      if (usage) {
        const context: ContextState = {
          estTokens,
          reportedTokens: usage.promptTokens + usage.completionTokens,
          effectiveWindow: window,
          limitingModel: window !== null ? win.limitingModel : null
        }
        s.setContext(chatId, context)
        ctx.emit({ type: 'context_updated', chatId, context })
      }
      if (signal.aborted) {
        return { kind: 'cancelled', requestId: rec.id, text, reasoning, calls: [], reported }
      }
      return { kind: 'ok', requestId: rec.id, text, reasoning, calls, reported }
    }
  }

  /** Conteúdo que vai ao modelo: completo, resumido (`summarizeToolOutputs`) ou truncado. */
  async function fitOutput(
    p: Prepared,
    full: string
  ): Promise<{ content: string; truncated: boolean }> {
    if (p.tool?.name === d.readToolOutput.name) return { content: full, truncated: false }
    const cfg = d.getConfig()
    if (cfg.summarizeToolOutputs && full.length > cfg.toolOutputMaxChars && !signal.aborted) {
      const chat = d.chats.get(chatId)
      const combo = chat?.combo || cfg.defaultCombo
      try {
        const content = await summarizeToolOutput(d.model, {
          toolName: p.spec.function.name,
          toolCallId: p.record.id,
          output: full,
          models: summarizerModels(cfg, combo),
          signal
        })
        return { content, truncated: true }
      } catch {
        // cai no truncamento abaixo
      }
    }
    return capToolOutput(full, cfg.toolOutputMaxChars, p.record.id)
  }

  const complete = async (p: Prepared, o: Outcome): Promise<ChatMessage> => {
    const full = o.content
    const outputBlobHash = ctx.blobs.put(full)
    const cap = await fitOutput(p, full)
    const record = d.toolCalls.update(p.record.id, {
      status: o.status,
      outputBlobHash,
      outputPreview: full.slice(0, PREVIEW_CHARS),
      outputTruncated: cap.truncated,
      finishedAt: Date.now()
    })
    ctx.emit({ type: 'tool_call_finished', chatId, toolCall: record })
    return { role: 'tool', tool_call_id: p.spec.id, content: cap.content }
  }

  const cancelledOutcome: Outcome = {
    content: CANCELLED_RESULT,
    isError: true,
    status: 'cancelled',
    images: []
  }

  async function execute(p: Prepared, project: Project): Promise<Outcome> {
    if (p.error || !p.tool) {
      return { content: p.error ?? 'Unknown tool', isError: true, status: 'error', images: [] }
    }
    if (signal.aborted) return cancelledOutcome
    const tool = p.tool
    const chat = d.chats.get(chatId)
    if (!chat) return cancelledOutcome
    const input = {
      chat,
      projectId: project.id,
      tool,
      args: p.args,
      toolCallId: p.record.id,
      targetPath: tool.kind === 'edit' ? editTarget(project.path, p.args) : undefined
    }
    if (d.gate.decide(input) === 'ask') {
      const waiting = d.toolCalls.update(p.record.id, { status: 'awaiting_approval' })
      ctx.emit({ type: 'tool_call_started', chatId, toolCall: waiting })
      const decision = await d.gate.request(input)
      if (signal.aborted) return cancelledOutcome
      if (decision === 'deny') {
        return { content: DENIED_RESULT, isError: true, status: 'denied', images: [] }
      }
    }
    const started = d.toolCalls.update(p.record.id, { status: 'running', startedAt: Date.now() })
    // Reemite com o status atualizado (a UI faz upsert por id).
    ctx.emit({ type: 'tool_call_started', chatId, toolCall: started })
    const cfg = d.getConfig()
    const toolCtx: ToolContext = {
      projectId: project.id,
      projectRoot: project.path,
      chatId,
      toolCallId: p.record.id,
      signal,
      blobs: ctx.blobs,
      capture,
      config: { shell: cfg.shell, shellTimeoutMs: cfg.shellTimeoutMs },
      onOutput: (delta) =>
        ctx.emit({ type: 'tool_output_delta', chatId, toolCallId: p.record.id, delta })
    }
    let result: ToolResult
    try {
      result = await tool.run(p.args, toolCtx)
    } catch (e) {
      result = { content: e instanceof Error ? e.message : String(e), isError: true }
    }
    const isError = result.isError === true
    return {
      content: result.content,
      isError,
      status: signal.aborted ? 'cancelled' : isError ? 'error' : 'done',
      images: result.images ?? []
    }
  }

  const prepare = (messageId: string, spec: ToolCallSpec): Prepared => {
    const name = spec.function.name
    const raw = spec.function.arguments ?? ''
    let args: unknown = undefined
    let error: string | null = null
    try {
      args = raw.trim() ? JSON.parse(raw) : {}
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        error = `Invalid arguments for tool ${name}: expected a JSON object.`
      }
    } catch (e) {
      error =
        `Invalid JSON in arguments for tool ${name}: ${e instanceof Error ? e.message : String(e)}. ` +
        'Retry the call with a valid JSON object.'
    }
    const tool = byName.get(name) ?? null
    if (!tool && !error) {
      error = `Unknown tool: ${name}. Available tools: ${[...byName.keys()].join(', ')}.`
    }
    const record = d.toolCalls.create({
      messageId,
      chatId,
      modelCallId: spec.id,
      name,
      args: args === undefined ? raw : args
    })
    ctx.emit({ type: 'tool_call_started', chatId, toolCall: record })
    return { spec, record, tool, args, error }
  }

  /**
   * Executa as tool calls; reads consecutivos em paralelo, edit/command em sequência.
   * Exceção: `task` consecutivas (subagentes) também rodam em paralelo.
   */
  async function runTools(
    messageId: string,
    calls: ToolCallSpec[],
    project: Project
  ): Promise<void> {
    const prepared = calls.map((c) => prepare(messageId, c))
    const groups: Prepared[][] = []
    let batch: Prepared[] = []
    let batchKind: 'read' | 'task' = 'read'
    for (const p of prepared) {
      const kind =
        !p.tool || p.error || p.tool.kind === 'read'
          ? 'read'
          : p.tool.name === TASK_TOOL
            ? 'task'
            : null
      if (kind) {
        if (batch.length && batchKind !== kind) {
          groups.push(batch)
          batch = []
        }
        batchKind = kind
        batch.push(p)
      } else {
        if (batch.length) groups.push(batch)
        batch = []
        groups.push([p])
      }
    }
    if (batch.length) groups.push(batch)

    const images: { mime: string; blobHash: string }[] = []
    for (const group of groups) {
      const outcomes = await Promise.all(group.map((p) => execute(p, project)))
      const messages = await Promise.all(group.map((p, i) => complete(p, outcomes[i])))
      outcomes.forEach((o, i) => {
        images.push(...o.images)
        const stored = d.messages.append(chatId, messages[i])
        ctx.emit({ type: 'message_added', chatId, message: stored })
      })
    }

    if (images.length && !signal.aborted) {
      const parts: ContentPart[] = [{ type: 'text', text: TOOL_IMAGES_TEXT }]
      for (const img of images)
        parts.push({ type: 'image_url', image_url: { url: `blob:${img.blobHash}` } })
      const msg: ChatMessage = { role: 'user', content: parts }
      const stored = d.messages.append(chatId, msg, { tokenEst: estimateMessage(msg) })
      for (const img of images) {
        const buf = ctx.blobs.get(img.blobHash)
        stored.attachments.push(
          d.messages.addAttachment(stored.id, {
            kind: 'image',
            name: 'tool-image',
            blobHash: img.blobHash,
            mime: img.mime,
            bytes: buf?.length ?? 0,
            width: null,
            height: null
          })
        )
      }
      ctx.emit({ type: 'message_added', chatId, message: stored })
    }
  }

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (signal.aborted) return finishCancelled()
      const chat = d.chats.get(chatId)
      if (!chat) return // chat excluído no meio do turno
      const project = d.projects.get(chat.projectId)
      if (!project) return fail('Projeto não encontrado', 'NOT_FOUND')
      const cfg = d.getConfig()
      const model = chat.combo || cfg.defaultCombo
      if (!model) return fail('Escolha um combo para este chat nas configurações', 'NO_MODEL')

      await s.ensureModels(model)
      const win = s.windowFor(model)
      const window = win.window
      const system = systemFor(project, cfg, opts.subagent)
      const estimate = (h: StoredMessage[]): number => estimateHistory(model, system, allTools, h)
      const cd = compactionDeps(d)
      const models = summarizerModels(cfg, model)

      if (window !== null) {
        try {
          const r = await ensureFits(cd, {
            chatId,
            window,
            thresholdPct: cfg.compactThresholdPct,
            keepRecent: cfg.keepRecentMessages,
            models,
            estimate,
            signal
          })
          if (signal.aborted) return finishCancelled()
          // Não coube no limiar nem compactando tudo: só falha se passar da janela inteira.
          if (!r.fits && estimate(d.messages.list(chatId)) > window) {
            return fail('A conversa não cabe na janela nem depois de compactar', 'CONTEXT_FULL')
          }
        } catch (e) {
          if (signal.aborted) return finishCancelled()
          if (estimate(d.messages.list(chatId)) >= window) {
            const msg = e instanceof Error ? e.message : String(e)
            return fail(`Falha ao compactar o contexto: ${msg}`, 'COMPACTION_FAILED')
          }
          // Ainda cabe na janela: segue sem compactar.
        }
      }

      let out: StreamOutcome
      for (let overflowRetry = 0; ; overflowRetry++) {
        const req = buildRequest({
          model,
          system,
          history: d.messages.list(chatId),
          tools: allTools,
          blobs: ctx.blobs
        })
        const estTokens = estimateRequest(req)
        const context: ContextState = {
          estTokens,
          reportedTokens: s.lastContext(chatId)?.reportedTokens ?? null,
          effectiveWindow: window,
          limitingModel: window !== null ? win.limitingModel : null
        }
        s.setContext(chatId, context)
        ctx.emit({ type: 'context_updated', chatId, context })

        out = await stream(req, estTokens, win)
        if (out.kind !== 'error' || !out.error.o.isContextLength || overflowRetry > 0) break
        // Overflow: compacta mais agressivo e tenta a mesma iteração uma única vez.
        let compacted: CompactionRecord | null = null
        try {
          compacted = await compactChat(cd, {
            chatId,
            trigger: 'overflow',
            keepRecent: Math.max(2, Math.floor(cfg.keepRecentMessages / 2)),
            models,
            estimate,
            signal
          })
        } catch {
          compacted = null
        }
        if (signal.aborted) return finishCancelled()
        if (!compacted) break
      }
      if (out.kind === 'error') {
        const e = out.error
        if (e.o.isAuth) return fail(AUTH_MESSAGE, 'AUTH')
        if (e.o.isContextLength) return fail(e.message, 'CONTEXT_LENGTH')
        return fail(e.message, e.o.code ?? 'MODEL_ERROR')
      }
      if (out.kind === 'cancelled') {
        if (out.text) {
          const partial: ChatMessage = { role: 'assistant', content: out.text }
          const stored = d.messages.append(chatId, partial, {
            tokenEst: estimateMessage(partial),
            requestId: out.requestId,
            ...(out.reported ? { modelUsed: out.reported } : {})
          })
          ctx.emit({ type: 'message_added', chatId, message: stored })
        }
        return finishCancelled()
      }

      const assistant: ChatMessage = {
        role: 'assistant',
        content: out.text || null,
        ...(out.calls.length ? { tool_calls: out.calls } : {}),
        ...(out.reasoning ? { reasoning: out.reasoning } : {})
      }
      const stored = d.messages.append(chatId, assistant, {
        tokenEst: estimateMessage(assistant),
        requestId: out.requestId,
        ...(out.reported ? { modelUsed: out.reported } : {})
      })
      ctx.emit({ type: 'message_added', chatId, message: stored })

      if (!out.calls.length) {
        s.setStatus(chatId, 'idle')
        ctx.emit({ type: 'turn_finished', chatId, requestId: out.requestId })
        return
      }

      await runTools(stored.id, out.calls, project)
      if (signal.aborted) return finishCancelled()
    }
    fail(`Limite de ${MAX_ITERATIONS} iterações atingido neste turno`, 'MAX_ITERATIONS')
  } catch (e) {
    if (signal.aborted) return finishCancelled()
    fail(e instanceof Error ? e.message : String(e), 'INTERNAL')
  }
}
