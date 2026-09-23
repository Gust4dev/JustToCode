import type { Approval, Chat, FileChange } from '@shared/domain'
import type { Tool } from '../tools/types'

export interface CaptureMeta {
  projectId: string
  projectRoot: string
  chatId: string
  toolCallId: string
}

export interface ChangeCapture {
  /** Registra uma escrita feita por ferramenta. before/after null = arquivo não existia/removido. */
  recordToolWrite(
    m: CaptureMeta,
    relPath: string,
    before: Buffer | null,
    after: Buffer | null
  ): FileChange | null
  /** Tira foto do estado git antes e depois de fn e registra as diferenças como origin=command. */
  withCommand<T>(
    m: CaptureMeta,
    fn: () => Promise<T>
  ): Promise<{ result: T; changes: FileChange[] }>
}

export interface PermissionInput {
  chat: Chat
  projectId: string
  tool: Tool
  args: unknown
  toolCallId: string
  /** Caminho alvo (relativo à raiz, com '/') de ferramentas `edit`; usado na checagem de colisão. */
  targetPath?: string
}

export interface PermissionGate {
  decide(input: PermissionInput): 'allow' | 'ask'
  /** Cria a aprovação, emite permission_requested e resolve quando o usuário decide (ou o chat é cancelado → 'deny'). */
  request(input: PermissionInput): Promise<'allow' | 'deny'>
  resolve(approvalId: string, decision: 'allow' | 'deny', remember: boolean): Approval
  cancelChat(chatId: string): void
  list(chatId?: string): Approval[]
}
