import {
  CHAT_COLORS,
  DEFAULT_CHAT_SETTINGS,
  type Chat,
  type ChatSettings,
  type ChatStatus,
  type PermissionMode
} from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

/** Padrão de `maxIterations` quando o chamador não informa (igual ao default da migração 5). */
export const DEFAULT_MAX_ITERATIONS = 50

interface ChatRow {
  id: string
  project_id: string
  parent_chat_id: string | null
  agent_name: string | null
  title: string
  color: string
  combo: string
  permission_mode: string
  status: string
  created_at: number
  group_id: string | null
  continued_from_chat_id: string | null
  max_iterations: number | null
  token_budget: number | null
  settings_json: string | null
  last_reported_model: string | null
}

const parseSettings = (json: string | null): ChatSettings => {
  if (!json) return { ...DEFAULT_CHAT_SETTINGS }
  try {
    const v = JSON.parse(json) as Partial<ChatSettings> | null
    return { ...DEFAULT_CHAT_SETTINGS, ...(v && typeof v === 'object' ? v : {}) }
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS }
  }
}

const toChat = (r: ChatRow): Chat => ({
  id: r.id,
  projectId: r.project_id,
  parentChatId: r.parent_chat_id,
  agentName: r.agent_name,
  title: r.title,
  color: r.color,
  combo: r.combo,
  permissionMode: r.permission_mode as PermissionMode,
  status: r.status as ChatStatus,
  createdAt: r.created_at,
  groupId: r.group_id,
  continuedFromChatId: r.continued_from_chat_id,
  maxIterations: r.max_iterations,
  tokenBudget: r.token_budget,
  settings: parseSettings(r.settings_json),
  lastReportedModel: r.last_reported_model
})

export interface ChatCreateInput {
  projectId: string
  title: string
  color: string
  combo: string
  permissionMode?: PermissionMode
  parentChatId?: string | null
  agentName?: string | null
  groupId?: string | null
  continuedFromChatId?: string | null
  /** `undefined` = padrão (50); `null` = sem limite. */
  maxIterations?: number | null
  tokenBudget?: number | null
  settings?: Partial<ChatSettings>
}

export interface ChatUpdatePatch {
  title?: string
  combo?: string
  permissionMode?: PermissionMode
  groupId?: string | null
  maxIterations?: number | null
  tokenBudget?: number | null
  /** Mesclado sobre as configurações atuais. */
  settings?: Partial<ChatSettings>
}

export class ChatRepo {
  constructor(private db: Db) {}

  create(i: ChatCreateInput): Chat {
    const row: ChatRow = {
      id: newId(),
      project_id: i.projectId,
      parent_chat_id: i.parentChatId ?? null,
      agent_name: i.agentName ?? null,
      title: i.title,
      color: i.color,
      combo: i.combo,
      permission_mode: i.permissionMode ?? 'ask',
      status: 'idle',
      created_at: Date.now(),
      group_id: i.groupId ?? null,
      continued_from_chat_id: i.continuedFromChatId ?? null,
      max_iterations: i.maxIterations === undefined ? DEFAULT_MAX_ITERATIONS : i.maxIterations,
      token_budget: i.tokenBudget ?? null,
      settings_json: JSON.stringify({ ...DEFAULT_CHAT_SETTINGS, ...(i.settings ?? {}) }),
      last_reported_model: null
    }
    this.db
      .prepare(
        `insert into chats (id, project_id, parent_chat_id, agent_name, title, color, combo,
           permission_mode, status, created_at, group_id, continued_from_chat_id, max_iterations,
           token_budget, settings_json, last_reported_model)
         values (@id, @project_id, @parent_chat_id, @agent_name, @title, @color, @combo,
           @permission_mode, @status, @created_at, @group_id, @continued_from_chat_id,
           @max_iterations, @token_budget, @settings_json, @last_reported_model)`
      )
      .run(row)
    return toChat(row)
  }

  get(id: string): Chat | null {
    const r = this.db.prepare('select * from chats where id = ?').get(id) as ChatRow | undefined
    return r ? toChat(r) : null
  }

  /** Só os chats de nível superior (subagentes ficam em `children`). */
  listByProject(projectId: string): Chat[] {
    const rows = this.db
      .prepare(
        `select * from chats where project_id = ? and parent_chat_id is null
         order by created_at desc, rowid desc`
      )
      .all(projectId) as ChatRow[]
    return rows.map(toChat)
  }

  /** Chats de nível superior de um grupo, do mais novo ao mais antigo. */
  listByGroup(groupId: string): Chat[] {
    const rows = this.db
      .prepare(
        `select * from chats where group_id = ? and parent_chat_id is null
         order by created_at desc, rowid desc`
      )
      .all(groupId) as ChatRow[]
    return rows.map(toChat)
  }

  /** Subagentes de um chat, do mais antigo ao mais novo. */
  children(parentId: string): Chat[] {
    const rows = this.db
      .prepare('select * from chats where parent_chat_id = ? order by created_at asc, rowid asc')
      .all(parentId) as ChatRow[]
    return rows.map(toChat)
  }

  update(id: string, p: ChatUpdatePatch): Chat {
    const cur = this.get(id)
    if (!cur) throw new Error(`Chat não encontrado: ${id}`)
    const settings = p.settings ? { ...cur.settings, ...p.settings } : cur.settings
    this.db
      .prepare(
        `update chats set title = ?, combo = ?, permission_mode = ?, group_id = ?,
           max_iterations = ?, token_budget = ?, settings_json = ? where id = ?`
      )
      .run(
        p.title ?? cur.title,
        p.combo ?? cur.combo,
        p.permissionMode ?? cur.permissionMode,
        p.groupId === undefined ? cur.groupId : p.groupId,
        p.maxIterations === undefined ? cur.maxIterations : p.maxIterations,
        p.tokenBudget === undefined ? cur.tokenBudget : p.tokenBudget,
        JSON.stringify(settings),
        id
      )
    return this.get(id) as Chat
  }

  setLastReportedModel(id: string, model: string | null): void {
    this.db.prepare('update chats set last_reported_model = ? where id = ?').run(model, id)
  }

  setStatus(id: string, status: ChatStatus): Chat {
    const r = this.db.prepare('update chats set status = ? where id = ?').run(status, id)
    if (r.changes === 0) throw new Error(`Chat não encontrado: ${id}`)
    return this.get(id) as Chat
  }

  /** Inicialização do host: chats `running`/`waiting_approval` viram `interrupted`. Devolve os ids. */
  markInterrupted(): string[] {
    const rows = this.db
      .prepare("select id from chats where status in ('running', 'waiting_approval')")
      .all() as { id: string }[]
    if (rows.length) {
      this.db
        .prepare(
          "update chats set status = 'interrupted' where status in ('running', 'waiting_approval')"
        )
        .run()
    }
    return rows.map((r) => r.id)
  }

  remove(id: string): void {
    this.db.prepare('delete from chats where id = ?').run(id)
  }

  nextColor(projectId: string): string {
    const { n } = this.db
      .prepare('select count(*) as n from chats where project_id = ?')
      .get(projectId) as { n: number }
    return CHAT_COLORS[n % CHAT_COLORS.length]
  }
}
