import type { ChatGroup } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface GroupRow {
  id: string
  project_id: string
  name: string
  sort_order: number
  collapsed: number
  created_at: number
}

const toGroup = (r: GroupRow): ChatGroup => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  sortOrder: r.sort_order,
  collapsed: r.collapsed === 1,
  createdAt: r.created_at
})

export interface ChatGroupPatch {
  name?: string
  collapsed?: boolean
  sortOrder?: number
}

export class ChatGroupRepo {
  constructor(private db: Db) {}

  /** Novo grupo entra no fim da ordem do projeto. */
  create(projectId: string, name: string): ChatGroup {
    const { next } = this.db
      .prepare(
        'select coalesce(max(sort_order), -1) + 1 as next from chat_groups where project_id = ?'
      )
      .get(projectId) as { next: number }
    const row: GroupRow = {
      id: newId(),
      project_id: projectId,
      name,
      sort_order: next,
      collapsed: 0,
      created_at: Date.now()
    }
    this.db
      .prepare(
        `insert into chat_groups (id, project_id, name, sort_order, collapsed, created_at)
         values (@id, @project_id, @name, @sort_order, @collapsed, @created_at)`
      )
      .run(row)
    return toGroup(row)
  }

  get(id: string): ChatGroup | null {
    const r = this.db.prepare('select * from chat_groups where id = ?').get(id) as
      GroupRow | undefined
    return r ? toGroup(r) : null
  }

  list(projectId: string): ChatGroup[] {
    const rows = this.db
      .prepare(
        'select * from chat_groups where project_id = ? order by sort_order asc, created_at asc, rowid asc'
      )
      .all(projectId) as GroupRow[]
    return rows.map(toGroup)
  }

  update(id: string, p: ChatGroupPatch): ChatGroup {
    const cur = this.get(id)
    if (!cur) throw new Error(`Grupo não encontrado: ${id}`)
    this.db
      .prepare('update chat_groups set name = ?, collapsed = ?, sort_order = ? where id = ?')
      .run(
        p.name ?? cur.name,
        (p.collapsed ?? cur.collapsed) ? 1 : 0,
        p.sortOrder ?? cur.sortOrder,
        id
      )
    return this.get(id) as ChatGroup
  }

  /** Os chats do grupo ficam sem grupo (FK `on delete set null`). */
  remove(id: string): void {
    this.db.prepare('delete from chat_groups where id = ?').run(id)
  }
}
