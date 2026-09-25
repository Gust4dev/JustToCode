import type { Approval, Chat, ChatStatus } from '@shared/domain'
import { RpcError } from '@shared/rpc'
import type { HostContext } from '../context'
import type { PermissionGate, PermissionInput } from '../services/types'
import { ApprovalRepo } from '../repo/approvals'
import { PermissionRuleRepo } from '../repo/permissionRules'
import { isSensitivePath, needsAlwaysConfirm } from './alwaysConfirm'
import { matchesRule, rulePatternFor } from './rules'
import { TASK_TOOL } from '../tools/task'

/** Resumo das aprovações de `task` (fallback quando o waiter já não existe). */
const TASK_SUMMARY_PREFIX = 'subagent '
/** Resumo das aprovações de `read_file` (fallback quando o waiter já não existe). */
const READ_SUMMARY_PREFIX = 'read '

/** Subconjunto estrutural de ChatRepo (Task 1.1) usado pelo gate. */
export interface GateChatRepo {
  get(id: string): Chat | null
  setStatus(id: string, status: ChatStatus): Chat
}

/** Subconjunto estrutural de FileChangeRepo usado na checagem de colisão. */
export interface GateFileChanges {
  chatsWithUnreviewed(projectId: string, path: string): string[]
}

/** Status de chat que ainda contam para colisão (o chat segue "vivo" com mudanças pendentes). */
const COLLISION_STATUSES: ReadonlySet<ChatStatus> = new Set(['running', 'waiting_approval', 'idle'])
export const COLLISION_SUFFIX = ' — outro chat também mexeu aqui'
export const collisionFlag = (chatId: string): string => `other_chat_touched:${chatId}`

interface Waiter {
  chatId: string
  /** Comando completo (o summary pode vir truncado). */
  command: string
  toolName: string
  toolKind: PermissionInput['tool']['kind']
  settle(decision: 'allow' | 'deny'): void
}

const commandOf = (args: unknown): string => {
  const c = (args as { command?: unknown } | null)?.command
  return typeof c === 'string' ? c : ''
}

/** Caminho alvo normalizado: `targetPath` explícito ou `args.path` (relativo, com '/'). */
const targetOf = (input: PermissionInput): string | null => {
  if (input.targetPath) return input.targetPath
  const p = (input.args as { path?: unknown } | null)?.path
  if (typeof p !== 'string' || !p) return null
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

export function createPermissionGate(
  ctx: HostContext,
  deps: { chats: GateChatRepo; fileChanges?: GateFileChanges }
): PermissionGate {
  const approvals = new ApprovalRepo(ctx.db)
  const rules = new PermissionRuleRepo(ctx.db)
  const waiters = new Map<string, Waiter>()

  const setChatStatus = (chatId: string, status: ChatStatus): void => {
    if (!deps.chats.get(chatId)) return
    deps.chats.setStatus(chatId, status)
    ctx.emit({ type: 'chat_status_changed', chatId, status })
  }

  /** Outros chats vivos com mudanças não revisadas no alvo de uma ferramenta `edit`. */
  const collidingChats = (input: PermissionInput): string[] => {
    if (input.tool.kind !== 'edit' || !deps.fileChanges) return []
    const path = targetOf(input)
    if (!path) return []
    return deps.fileChanges.chatsWithUnreviewed(input.projectId, path).filter((id) => {
      if (id === input.chat.id) return false
      const other = deps.chats.get(id)
      return !!other && COLLISION_STATUSES.has(other.status)
    })
  }

  const decide: PermissionGate['decide'] = (input) => {
    const { chat, projectId, tool, args } = input
    if (tool.kind === 'read') {
      // Leitura de credenciais/segredos sempre pergunta, mesmo em allow-all.
      const path = targetOf(input)
      return path && isSensitivePath(path) ? 'ask' : 'allow'
    }
    // Colisão sempre pergunta: nem allow-all nem regra "Sempre" liberam.
    if (collidingChats(input).length > 0) return 'ask'
    // Subagentes: allow-all ou a regra própria `task` do projeto (nunca regra de shell).
    if (tool.name === TASK_TOOL) {
      if (chat.permissionMode === 'allow-all') return 'allow'
      return rules.list(projectId, 'task').some((r) => r.pattern === '*') ? 'allow' : 'ask'
    }
    if (tool.kind === 'command') {
      const command = commandOf(args)
      if (needsAlwaysConfirm(command)) return 'ask'
      if (chat.permissionMode === 'allow-all') return 'allow'
      const allowed = rules.list(projectId, 'shell').some((r) => matchesRule(command, r.pattern))
      return allowed ? 'allow' : 'ask'
    }
    if (chat.permissionMode === 'auto-edit' || chat.permissionMode === 'allow-all') return 'allow'
    return rules.list(projectId, 'edit').some((r) => r.pattern === '*') ? 'allow' : 'ask'
  }

  const request = (input: PermissionInput): Promise<'allow' | 'deny'> => {
    const { chat, projectId, tool, args, toolCallId } = input
    const colliding = collidingChats(input)
    const summary = tool.summarize(args)
    const approval = approvals.create({
      chatId: chat.id,
      projectId,
      toolCallId,
      kind: tool.kind === 'command' ? 'command' : 'edit',
      summary: colliding.length > 0 ? summary + COLLISION_SUFFIX : summary,
      flags: colliding.map(collisionFlag)
    })
    const promise = new Promise<'allow' | 'deny'>((settle) => {
      waiters.set(approval.id, {
        chatId: chat.id,
        command: commandOf(args),
        toolName: tool.name,
        toolKind: tool.kind,
        settle
      })
    })
    setChatStatus(chat.id, 'waiting_approval')
    ctx.emit({ type: 'permission_requested', approval })
    return promise
  }

  const settle = (approval: Approval, decision: 'allow' | 'deny'): Approval => {
    const decided = approvals.decide(approval.id, decision === 'allow' ? 'allowed' : 'denied')
    ctx.emit({ type: 'permission_resolved', approval: decided })
    return decided
  }

  const resolve: PermissionGate['resolve'] = (approvalId, decision, remember) => {
    const approval = approvals.get(approvalId)
    if (!approval) throw new RpcError('Aprovação não encontrada', 'NOT_FOUND')
    if (approval.status !== 'pending') {
      throw new RpcError('Aprovação já decidida', 'ALREADY_DECIDED')
    }
    const waiter = waiters.get(approvalId)
    // Leitura sensível nunca vira regra lembrada: cada acesso pergunta de novo.
    const isRead = waiter
      ? waiter.toolKind === 'read'
      : approval.summary.startsWith(READ_SUMMARY_PREFIX)
    if (remember && decision === 'allow' && !isRead) {
      const isTask = waiter
        ? waiter.toolName === TASK_TOOL
        : approval.summary.startsWith(TASK_SUMMARY_PREFIX)
      if (isTask) {
        rules.add(approval.projectId, 'task', '*')
      } else if (approval.kind === 'command') {
        const pattern = rulePatternFor(waiter?.command || approval.summary)
        if (pattern) rules.add(approval.projectId, 'shell', pattern)
      } else {
        rules.add(approval.projectId, 'edit', '*')
      }
    }
    const decided = settle(approval, decision)
    waiters.delete(approvalId)
    if (waiter) {
      const stillPending = [...waiters.values()].some((w) => w.chatId === waiter.chatId)
      if (!stillPending) setChatStatus(waiter.chatId, 'running')
      waiter.settle(decision)
    }
    return decided
  }

  const cancelChat: PermissionGate['cancelChat'] = (chatId) => {
    for (const approval of approvals.listPending(chatId)) {
      settle(approval, 'deny')
      const waiter = waiters.get(approval.id)
      waiters.delete(approval.id)
      waiter?.settle('deny')
    }
  }

  return { decide, request, resolve, cancelChat, list: (chatId) => approvals.list(chatId) }
}
