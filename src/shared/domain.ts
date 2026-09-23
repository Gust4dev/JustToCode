export type PermissionMode = 'ask' | 'auto-edit' | 'allow-all'
export type ChatStatus = 'idle' | 'running' | 'waiting_approval' | 'interrupted' | 'error'

export interface Project {
  id: string
  path: string
  name: string
  createdAt: number
  lastOpenedAt: number | null
}

export interface Chat {
  id: string
  projectId: string
  parentChatId: string | null
  agentName: string | null
  title: string
  color: string
  combo: string
  permissionMode: PermissionMode
  status: ChatStatus
  createdAt: number
}

export interface ToolCallSpec {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Imagens ficam como `blob:<sha256>` no banco; o engine troca por data URL ao montar o request. */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallSpec[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface AttachmentMeta {
  id: string
  kind: 'image' | 'file'
  name: string
  blobHash: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
}

export type MessageKind = 'message' | 'summary'

export interface StoredMessage {
  id: string
  chatId: string
  seq: number
  message: ChatMessage
  tokenEst: number | null
  modelUsed: string | null
  requestId: string | null
  compacted: boolean
  kind: MessageKind
  createdAt: number
  attachments: AttachmentMeta[]
}

export type CompactionTrigger = 'auto' | 'manual' | 'overflow'

export interface CompactionRecord {
  id: string
  chatId: string
  fromSeq: number
  toSeq: number
  summaryMessageId: string
  previousCompactionId: string | null
  summarizerModel: string
  tokensBefore: number
  tokensAfter: number
  trigger: CompactionTrigger
  createdAt: number
}

export interface ComboInfo {
  combo: string
  isCombo: boolean
  members: string[]
  ignored: string[]
  windows: Record<string, number | null>
  effectiveWindow: number | null
  limitingModel: string | null
  source: 'router-db' | 'manual' | 'model' | 'unknown'
  warning: string | null
}

export type ToolCallStatus =
  'pending' | 'awaiting_approval' | 'running' | 'done' | 'error' | 'denied' | 'cancelled'

export interface ToolCallRecord {
  id: string
  modelCallId: string
  messageId: string
  chatId: string
  name: string
  args: unknown
  status: ToolCallStatus
  outputPreview: string | null
  outputTruncated: boolean
  startedAt: number | null
  finishedAt: number | null
}

export type ChangeOrigin = 'tool' | 'command' | 'external' | 'ambiguous'

export interface FileChange {
  id: string
  projectId: string
  chatId: string | null
  candidateChatIds: string[]
  origin: ChangeOrigin
  path: string
  beforeHash: string | null
  afterHash: string | null
  toolCallId: string | null
  createdAt: number
  reviewedAt: number | null
  revertedAt: number | null
}

export interface ChangedFileSummary {
  path: string
  chatIds: string[]
  origins: ChangeOrigin[]
  baseHash: string | null
  currentHash: string | null
  additions: number
  deletions: number
  binary: boolean
}

export interface Approval {
  id: string
  chatId: string
  projectId: string
  toolCallId: string
  kind: 'edit' | 'command'
  summary: string
  flags: string[]
  status: 'pending' | 'allowed' | 'denied'
  decidedAt: number | null
}

export interface ModelInfo {
  id: string
  ownedBy: string
  isCombo: boolean
  contextWindow: number | null
  maxOutput: number | null
  vision: boolean
  tools: boolean
}

export interface RequestRecord {
  id: string
  chatId: string
  modelRequested: string
  modelReported: string | null
  promptTokens: number | null
  completionTokens: number | null
  estTokens: number | null
  effectiveWindow: number | null
  startedAt: number
  finishedAt: number | null
  error: string | null
}

export interface ContextState {
  estTokens: number
  reportedTokens: number | null
  effectiveWindow: number | null
  limitingModel: string | null
}

export type EcosystemScope = 'global' | 'project'

export interface InstructionFile {
  path: string
  scope: EcosystemScope
  bytes: number
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  scope: EcosystemScope
}

export interface SlashCommand {
  name: string
  description: string
  source: 'command' | 'skill'
  path: string
  scope: EcosystemScope
}

export interface AgentDefinition {
  name: string
  description: string
  tools: string[] | null
  combo: string | null
  path: string
  scope: EcosystemScope
}

/** Conflito do revert de três vias; `merged` traz os marcadores de conflito. */
export interface RevertConflict {
  path: string
  base: string
  current: string
  reverted: string
  merged: string
}

export interface AppConfig {
  routerBaseUrl: string
  routerApiKey: string
  defaultCombo: string
  lightCombo: string
  shell: 'auto' | 'pwsh' | 'powershell'
  shellTimeoutMs: number
  toolOutputMaxChars: number
  /** % da janela efetiva que dispara a compactação automática. */
  compactThresholdPct: number
  /** Mensagens recentes que nunca entram na compactação. */
  keepRecentMessages: number
  /** '' = usa lightCombo; se vazio, a combo do chat. */
  summarizerModel: string
  summarizeToolOutputs: boolean
  /** '' = %APPDATA%/9router/db/data.sqlite */
  routerDbPath: string
  unknownWindowFallback: number
  /** Arquivos de instrução globais (somente leitura). `~` é expandido no uso. */
  instructionFiles: string[]
  /** Pastas de skills globais (somente leitura). `~` é expandido no uso. */
  skillRoots: string[]
  /** Pastas de slash commands globais (somente leitura). `~` é expandido no uso. */
  commandRoots: string[]
  /** Pastas de definições de agents globais (somente leitura). `~` é expandido no uso. */
  agentRoots: string[]
  /** Raízes de plugins no layout do cache do Claude Code (somente leitura). `~` é expandido no uso. */
  pluginRoots: string[]
}

export const DEFAULT_CONFIG: AppConfig = {
  routerBaseUrl: 'http://localhost:20128/v1',
  routerApiKey: '',
  defaultCombo: '',
  lightCombo: '',
  shell: 'auto',
  shellTimeoutMs: 120_000,
  toolOutputMaxChars: 40_000,
  compactThresholdPct: 70,
  keepRecentMessages: 8,
  summarizerModel: '',
  summarizeToolOutputs: false,
  routerDbPath: '',
  unknownWindowFallback: 128_000,
  instructionFiles: ['~/.claude/CLAUDE.md', '~/.codex/AGENTS.md'],
  skillRoots: ['~/.claude/skills', '~/.agents/skills'],
  commandRoots: ['~/.claude/commands'],
  agentRoots: ['~/.claude/agents'],
  pluginRoots: ['~/.claude/plugins/cache']
}

export const CHAT_COLORS = [
  '#7F77DD',
  '#1D9E75',
  '#D85A30',
  '#D4537E',
  '#378ADD',
  '#BA7517',
  '#639922',
  '#E24B4A'
]
