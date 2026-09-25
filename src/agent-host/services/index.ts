import type { AppConfig } from '@shared/domain'
import type { HostContext } from '../context'
import { getConfig as getHostConfig, onConfig as onHostConfig } from '../config'
import { ProjectRepo } from '../repo/projects'
import { ChatRepo } from '../repo/chats'
import { MessageRepo } from '../repo/messages'
import { RequestRepo } from '../repo/requests'
import { ToolCallRepo } from '../repo/toolCalls'
import { FileChangeRepo } from '../repo/fileChanges'
import { createPermissionGate } from '../permissions/gate'
import { createChangeCapture } from '../attribution/capture'
import { CommandWindowRegistry, RecentToolWrites } from '../attribution/commandWindows'
import { createProjectWatcher, type ProjectWatcher } from '../attribution/watcher'
import { getModelClient } from '../handlers/models'
import type { ModelClient } from '../model/types'
import { fileTools } from '../tools'
import { commandTools } from '../tools/commandTools'
import type { Tool } from '../tools/types'
import { createSkillTool } from '../tools/skill'
import { createMemoryTools } from '../tools/memory'
import { MemoryService } from '../memory/memory'
import { createTaskTool } from '../tools/task'
import { createAgentEngine, type AgentEngine } from '../engine/agentEngine'
import { createReadToolOutputTool } from '../engine/toolOutput'
import type { ChangeCapture, PermissionGate } from './types'
import { ComboOverrideRepo } from '../repo/comboOverrides'
import { ModelWindowRepo } from '../repo/modelWindows'
import { createComboResolver, type ComboResolver } from '../context/comboResolver'
import { CompactionRepo } from '../repo/compactions'
import { createSummarizer, type Summarizer } from '../context/summarizer'
import { ChatGroupRepo } from '../repo/chatGroups'
import { createContinuation, type Continuation } from './continuation'
import { InstructionRepo } from '../repo/instructions'
import { TouchedPathRepo } from '../repo/touchedPaths'
import {
  createInstructionResolver,
  resolveInstructions,
  type InstructionResolver
} from '../ecosystem/resolver'

export interface Services {
  projects: ProjectRepo
  chats: ChatRepo
  messages: MessageRepo
  requests: RequestRepo
  toolCalls: ToolCallRepo
  fileChanges: FileChangeRepo
  gate: PermissionGate
  capture: ChangeCapture
  model: ModelClient
  tools: Tool[]
  readToolOutput: Tool
  engine: AgentEngine
  comboOverrides: ComboOverrideRepo
  modelWindows: ModelWindowRepo
  comboResolver: ComboResolver
  compactions: CompactionRepo
  summarizer: Summarizer
  groups: ChatGroupRepo
  continuation: Continuation
  instructionRepo: InstructionRepo
  touchedPaths: TouchedPathRepo
  /** Resolvedor de instruções (prompt, `@nome`, caminhos tocados, provedores dinâmicos). */
  instructions: InstructionResolver
  /** Memórias (`kind: memory`): save/undo/lote por origem + seção `# Memory` do prompt. */
  memory: MemoryService
  /** Chats marcados como `interrupted` na inicialização. */
  interrupted: string[]
  getConfig: () => AppConfig
  /** Janelas de comandos em execução (atribuição concorrente). */
  commandWindows: CommandWindowRegistry
  watcher: ProjectWatcher
  /** Liga o watcher do projeto (idempotente; no-op se `watch` estiver desligado). */
  watchProject(projectId: string): void
}

export interface ServiceOptions {
  model?: ModelClient
  getConfig?: () => AppConfig
  retryDelaysMs?: number[]
  onConfig?: (listener: () => void) => unknown
  /** Substitui o resolver de janelas (testes). */
  comboResolver?: ComboResolver
  /** Liga o watcher de arquivos por projeto (host real: true; testes: padrão false). */
  watch?: boolean
}

/** Container único do agent-host: repos, gate, captura, modelo, ferramentas e engine. */
export function createServices(ctx: HostContext, opts: ServiceOptions = {}): Services {
  const getConfig = opts.getConfig ?? getHostConfig
  const projects = new ProjectRepo(ctx.db)
  const chats = new ChatRepo(ctx.db)
  const messages = new MessageRepo(ctx.db)
  const requests = new RequestRepo(ctx.db)
  const toolCalls = new ToolCallRepo(ctx.db)
  const fileChanges = new FileChangeRepo(ctx.db)
  const gate = createPermissionGate(ctx, { chats, fileChanges })
  const commandWindows = new CommandWindowRegistry()
  const toolWrites = new RecentToolWrites()
  const capture = createChangeCapture(ctx, fileChanges, { registry: commandWindows, toolWrites })
  const watcher = createProjectWatcher({
    ctx,
    repo: fileChanges,
    registry: commandWindows,
    toolWrites,
    blobs: ctx.blobs
  })
  const watchProject = (projectId: string): void => {
    if (!opts.watch) return
    const project = projects.get(projectId)
    if (!project) return
    watcher.start(project.id, project.path).catch((e) => {
      console.warn(`[watcher] não foi possível observar ${project.path}:`, e)
    })
  }
  // Chat rodando ⇒ o projeto dele precisa estar observado.
  const engineCtx: HostContext = {
    ...ctx,
    emit: (e) => {
      if (e.type === 'turn_started') {
        const chat = chats.get(e.chatId)
        if (chat) watchProject(chat.projectId)
      }
      ctx.emit(e)
    }
  }
  const model = opts.model ?? getModelClient()
  // `task` chama o engine, que só existe depois das ferramentas (ligação tardia).
  let engineRef: AgentEngine | null = null
  const taskTool = createTaskTool(() => (req) => {
    if (!engineRef) throw new Error('engine não inicializado')
    return engineRef.runSubagent(req)
  })
  const instructionRepo = new InstructionRepo(ctx.db)
  const touchedPaths = new TouchedPathRepo(ctx.db)
  const instructions = createInstructionResolver({ repo: instructionRepo, touched: touchedPaths })
  const skillTool = createSkillTool(getConfig, (tctx) => {
    const chat = chats.get(tctx.chatId)
    const cfg = getConfig()
    const candidates = instructions.candidates({
      projectRoot: tctx.projectRoot,
      projectId: tctx.projectId,
      groupId: chat?.groupId ?? null,
      chatId: tctx.chatId,
      cfg
    })
    return resolveInstructions(candidates, {
      chatId: tctx.chatId,
      touchedPaths: [],
      manualNames: [],
      budget: cfg.alwaysInstructionBudgetTokens
    }).listed
  })
  const memory = new MemoryService(instructionRepo)
  instructions.registerSection((c) => memory.section(c))
  const memoryTools = createMemoryTools({
    memory,
    groupIdOf: (chatId) => chats.get(chatId)?.groupId ?? null,
    requestIdOf: (chatId) => requests.list(chatId).at(-1)?.id ?? null,
    thirdPartyOf: (chatId) =>
      (instructions.lastActive(chatId)?.items ?? [])
        .filter((i) => i.included !== 'dropped')
        .map((i) => i.id)
        .filter((id) => instructionRepo.get(id)?.source.type === 'github'),
    onSaved: (e) => ctx.emit({ type: 'memory_saved', ...e })
  })
  const tools = [...fileTools, ...commandTools, skillTool, taskTool, ...memoryTools]
  const readToolOutput = createReadToolOutputTool(toolCalls)
  const comboOverrides = new ComboOverrideRepo(ctx.db)
  const modelWindows = new ModelWindowRepo(ctx.db)
  const comboResolver =
    opts.comboResolver ??
    createComboResolver({
      listModels: () => model.listModels(),
      overrides: comboOverrides,
      windows: modelWindows,
      getConfig
    })
  const compactions = new CompactionRepo(ctx.db)
  const summarizer = createSummarizer(model)
  const groups = new ChatGroupRepo(ctx.db)
  const continuation = createContinuation({ ctx, chats, groups, messages, summarizer, getConfig })

  // Crash anterior do host: turnos em andamento não podem ser retomados.
  const interrupted = chats.markInterrupted()
  for (const chatId of interrupted) gate.cancelChat(chatId)

  const engine = createAgentEngine({
    ctx: engineCtx,
    projects,
    chats,
    messages,
    requests,
    toolCalls,
    model,
    tools,
    gate,
    capture,
    getConfig,
    readToolOutput,
    resolver: comboResolver,
    compactions,
    summarizer,
    retryDelaysMs: opts.retryDelaysMs,
    instructions,
    onConfig: opts.onConfig ?? (opts.getConfig ? undefined : onHostConfig)
  })
  engineRef = engine

  return {
    projects,
    chats,
    messages,
    requests,
    toolCalls,
    fileChanges,
    gate,
    capture,
    model,
    tools,
    readToolOutput,
    engine,
    comboOverrides,
    modelWindows,
    comboResolver,
    compactions,
    summarizer,
    groups,
    continuation,
    instructionRepo,
    touchedPaths,
    instructions,
    memory,
    interrupted,
    getConfig,
    commandWindows,
    watcher,
    watchProject
  }
}
