import { CHAT_COLORS, type Chat, type ChatStatus, type PermissionMode } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

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
  createdAt: r.created_at
})

export interface ChatCreateInput {
  projectId: string
  title: string
  color: string
  combo: string
  permissionMode?: PermissionMode
  parentChatId?: string | null
  agentName?: string | null
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
      created_at: Date.now()
    }
    this.db
      .prepare(
        `insert into chats (id, project_id, parent_chat_id, agent_name, title, color, combo,
           permission_mode, status, created_at)
         values (@id, @project_id, @parent_chat_id, @agent_name, @title, @color, @combo,
           @permission_mode, @status, @created_at)`
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

  /** Subagentes de um chat, do mais antigo ao mais novo. */
  children(parentId: string): Chat[] {
    const rows = this.db
      .prepare('select * from chats where parent_chat_id = ? order by created_at asc, rowid asc')
      .all(parentId) as ChatRow[]
    return rows.map(toChat)
  }

  update(id: string, p: Partial<Pick<Chat, 'title' | 'combo' | 'permissionMode'>>): Chat {
    const cur = this.get(id)
    if (!cur) throw new Error(`Chat não encontrado: ${id}`)
    this.db
      .prepare('update chats set title = ?, combo = ?, permission_mode = ? where id = ?')
      .run(p.title ?? cur.title, p.combo ?? cur.combo, p.permissionMode ?? cur.permissionMode, id)
    return this.get(id) as Chat
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
