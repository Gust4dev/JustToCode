import type { Approval } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface ApprovalRow {
  id: string
  chat_id: string
  project_id: string | null
  tool_call_id: string
  kind: string
  summary: string
  flags_json: string | null
  status: string
  decided_at: number | null
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    chatId: r.chat_id,
    projectId: r.project_id ?? '',
    toolCallId: r.tool_call_id,
    kind: r.kind as Approval['kind'],
    summary: r.summary,
    flags: r.flags_json ? (JSON.parse(r.flags_json) as string[]) : [],
    status: r.status as Approval['status'],
    decidedAt: r.decided_at
  }
}

export class ApprovalRepo {
  constructor(private db: Db) {}

  create(i: {
    chatId: string
    projectId: string
    toolCallId: string
    kind: Approval['kind']
    summary: string
    flags: string[]
  }): Approval {
    const id = newId()
    this.db
      .prepare(
        `insert into approvals (id, chat_id, project_id, tool_call_id, kind, summary, flags_json, status)
         values (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(id, i.chatId, i.projectId, i.toolCallId, i.kind, i.summary, JSON.stringify(i.flags))
    return this.get(id) as Approval
  }

  get(id: string): Approval | null {
    const r = this.db.prepare('select * from approvals where id = ?').get(id) as
      ApprovalRow | undefined
    return r ? toApproval(r) : null
  }

  decide(id: string, status: 'allowed' | 'denied'): Approval {
    this.db
      .prepare('update approvals set status = ?, decided_at = ? where id = ?')
      .run(status, Date.now(), id)
    const a = this.get(id)
    if (!a) throw new Error(`aprovação não encontrada: ${id}`)
    return a
  }

  /** Pendentes primeiro; dentro de cada grupo, mais antigas primeiro (rowid). */
  list(chatId?: string): Approval[] {
    const rows = (
      chatId
        ? this.db
            .prepare(
              "select * from approvals where chat_id = ? order by status <> 'pending', rowid"
            )
            .all(chatId)
        : this.db.prepare("select * from approvals order by status <> 'pending', rowid").all()
    ) as ApprovalRow[]
    return rows.map(toApproval)
  }

  listPending(chatId: string): Approval[] {
    const rows = this.db
      .prepare("select * from approvals where chat_id = ? and status = 'pending' order by rowid")
      .all(chatId) as ApprovalRow[]
    return rows.map(toApproval)
  }
}
