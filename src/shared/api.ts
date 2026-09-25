import type {
  AgentDefinition,
  ActiveInstructions,
  Approval,
  ChangedFileSummary,
  Chat,
  ChatGroup,
  ChatSettings,
  ComboInfo,
  CompactionRecord,
  ContextState,
  InstallPreview,
  Instruction,
  InstructionFile,
  InstructionKind,
  InstructionScope,
  ModelInfo,
  PermissionMode,
  Project,
  QueueState,
  RequestRecord,
  RevertConflict,
  SettingSuggestion,
  SkillInfo,
  SlashCommand,
  StoredMessage,
  ToolCallRecord
} from './domain'

export interface AttachmentUpload {
  name: string
  mime: string
  dataBase64: string
}

export interface HostApi {
  'host.ping': { params: null; result: { ok: true; pid: number; version: string } }
  'projects.open': { params: { path: string }; result: Project }
  'projects.list': { params: null; result: Project[] }
  'projects.remove': { params: { id: string }; result: null }
  'chats.list': { params: { projectId: string }; result: Chat[] }
  'chats.create': { params: { projectId: string; title?: string; combo?: string }; result: Chat }
  'chats.update': {
    params: {
      id: string
      title?: string
      combo?: string
      permissionMode?: PermissionMode
      groupId?: string | null
      maxIterations?: number | null
      tokenBudget?: number | null
      settings?: Partial<ChatSettings>
    }
    result: Chat
  }
  'chats.delete': { params: { id: string }; result: null }
  'chats.children': { params: { chatId: string }; result: Chat[] }
  'messages.list': { params: { chatId: string }; result: StoredMessage[] }
  'toolCalls.list': { params: { chatId: string }; result: ToolCallRecord[] }
  'toolCalls.output': { params: { id: string }; result: { text: string } }
  'engine.send': {
    params: { chatId: string; text: string; attachments: AttachmentUpload[] }
    result: { messageId: string | null; queuedId: string | null }
  }
  'engine.cancel': { params: { chatId: string }; result: null }
  'approvals.list': { params: { chatId?: string }; result: Approval[] }
  'approvals.decide': {
    params: { id: string; decision: 'allow' | 'deny'; remember: boolean }
    result: null
  }
  'changes.list': { params: { projectId: string; chatId?: string }; result: ChangedFileSummary[] }
  'changes.fileDiff': {
    params: { projectId: string; path: string; chatId?: string }
    result: { before: string | null; after: string | null; binary: boolean }
  }
  'changes.accept': { params: { projectId: string; path?: string; chatId?: string }; result: null }
  'changes.revert': {
    params: { projectId: string; chatId: string; path: string }
    result: { status: 'reverted' | 'conflict'; message?: string; conflict?: RevertConflict }
  }
  'changes.resolveConflict': {
    params: {
      projectId: string
      chatId: string
      path: string
      choice: 'keep-current' | 'apply-revert' | 'manual'
      content?: string
    }
    result: null
  }
  'requests.list': { params: { chatId: string }; result: RequestRecord[] }
  'requests.payload': { params: { id: string }; result: { json: string } }
  'models.list': { params: null; result: ModelInfo[] }
  'context.get': { params: { chatId: string }; result: ContextState }
  'compaction.run': { params: { chatId: string }; result: CompactionRecord }
  'compaction.list': { params: { chatId: string }; result: CompactionRecord[] }
  'compaction.get': {
    params: { id: string }
    result: { record: CompactionRecord; summary: string; originals: StoredMessage[] }
  }
  'combos.info': { params: { combo: string }; result: ComboInfo }
  'combos.setOverride': {
    params: {
      combo: string
      members?: string[] | null
      ignored?: string[]
      windowOverride?: number | null
    }
    result: ComboInfo
  }
  'models.setWindow': { params: { modelId: string; contextWindow: number | null }; result: null }
  'ecosystem.instructions': { params: { projectId: string }; result: InstructionFile[] }
  'ecosystem.skills': { params: { projectId: string }; result: SkillInfo[] }
  'ecosystem.commands': { params: { projectId: string }; result: SlashCommand[] }
  'ecosystem.expandCommand': {
    params: { projectId: string; name: string; args: string }
    result: { text: string }
  }
  'ecosystem.agents': { params: { projectId: string }; result: AgentDefinition[] }
  'git.commitMessage': {
    params: { projectId: string }
    result: { message: string; staged: boolean; model: string }
  }
  'queue.get': { params: { chatId: string }; result: QueueState }
  'queue.remove': { params: { id: string }; result: QueueState }
  'queue.edit': { params: { id: string; text: string }; result: QueueState }
  'queue.resume': { params: { chatId: string }; result: QueueState }
  /** Retoma após `turn_paused`. */
  'engine.continue': { params: { chatId: string }; result: null }
  'chats.generateTitle': { params: { chatId: string }; result: Chat }
  'chats.continue': { params: { chatId: string }; result: Chat }
  'groups.list': { params: { projectId: string }; result: ChatGroup[] }
  'groups.create': { params: { projectId: string; name: string }; result: ChatGroup }
  'groups.update': {
    params: { id: string; name?: string; collapsed?: boolean; sortOrder?: number }
    result: ChatGroup
  }
  /** Os chats do grupo ficam sem grupo. */
  'groups.delete': { params: { id: string }; result: null }
  'instructions.list': {
    params: { projectId?: string; groupId?: string; chatId?: string; kind?: InstructionKind }
    result: Instruction[]
  }
  'instructions.save': {
    params: Partial<Instruction> & Pick<Instruction, 'kind' | 'scope' | 'name' | 'trigger' | 'body'>
    result: Instruction
  }
  'instructions.delete': { params: { id: string }; result: null }
  'instructions.setEnabled': { params: { id: string; enabled: boolean }; result: Instruction }
  'instructions.active': { params: { chatId: string }; result: ActiveInstructions }
  'instructions.export': { params: { id: string; projectId: string }; result: { path: string } }
  'rules.parse': {
    params: { chatId: string; text: string }
    result: { ruleText: string; suggestions: SettingSuggestion[] }
  }
  'memory.undo': { params: { id: string }; result: null }
  'memory.deleteByOrigin': { params: { thirdPartyId: string }; result: { deleted: number } }
  'library.previewGithub': { params: { url: string }; result: InstallPreview }
  'library.installGithub': {
    params: {
      url: string
      ref: string
      sha: string
      paths: string[]
      scope: InstructionScope
      scopeId: string | null
    }
    result: Instruction[]
  }
  'library.checkUpdate': {
    params: { id: string }
    result: { hasUpdate: boolean; preview: InstallPreview | null }
  }
}

export type HostMethod = keyof HostApi
export type HostParams<M extends HostMethod> = HostApi[M]['params']
export type HostResult<M extends HostMethod> = HostApi[M]['result']
