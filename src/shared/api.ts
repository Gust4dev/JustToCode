import type {
  AgentDefinition,
  Approval,
  ChangedFileSummary,
  Chat,
  ComboInfo,
  CompactionRecord,
  ContextState,
  InstructionFile,
  ModelInfo,
  PermissionMode,
  Project,
  RequestRecord,
  RevertConflict,
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
    params: { id: string; title?: string; combo?: string; permissionMode?: PermissionMode }
    result: Chat
  }
  'chats.delete': { params: { id: string }; result: null }
  'chats.children': { params: { chatId: string }; result: Chat[] }
  'messages.list': { params: { chatId: string }; result: StoredMessage[] }
  'toolCalls.list': { params: { chatId: string }; result: ToolCallRecord[] }
  'toolCalls.output': { params: { id: string }; result: { text: string } }
  'engine.send': {
    params: { chatId: string; text: string; attachments: AttachmentUpload[] }
    result: { messageId: string }
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
}

export type HostMethod = keyof HostApi
export type HostParams<M extends HostMethod> = HostApi[M]['params']
export type HostResult<M extends HostMethod> = HostApi[M]['result']
