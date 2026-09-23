import type { ChangeOrigin, FileChange } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface FileChangeRow {
  id: string
  project_id: string
  chat_id: string | null
  candidate_chat_ids: string | null
  origin: string
  path: string
  before_hash: string | null
  after_hash: string | null
  tool_call_id: string | null
  created_at: number
  reviewed_at: number | null
  reverted_at: number | null
}

function toFileChange(r: FileChangeRow): FileChange {
  return {
    id: r.id,
    projectId: r.project_id,
    chatId: r.chat_id,
    candidateChatIds: r.candidate_chat_ids ? (JSON.parse(r.candidate_chat_ids) as string[]) : [],
    origin: r.origin as ChangeOrigin,
    path: r.path,
    beforeHash: r.before_hash,
    afterHash: r.after_hash,
    toolCallId: r.tool_call_id,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    revertedAt: r.reverted_at
  }
}

const PENDING = 'reviewed_at is null and reverted_at is null'

export class FileChangeRepo {
  constructor(private db: Db) {}

  insert(c: Omit<FileChange, 'id' | 'createdAt' | 'reviewedAt' | 'revertedAt'>): FileChange {
    const id = newId()
    this.db
      .prepare(
        `insert into file_changes (id, project_id, chat_id, candidate_chat_ids, origin, path,
           before_hash, after_hash, tool_call_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        c.projectId,
        c.chatId,
        JSON.stringify(c.candidateChatIds),
        c.origin,
        c.path,
        c.beforeHash,
        c.afterHash,
        c.toolCallId,
        Date.now()
      )
    return this.get(id) as FileChange
  }

  get(id: string): FileChange | null {
    const r = this.db.prepare('select * from file_changes where id = ?').get(id) as
      FileChangeRow | undefined
    return r ? toFileChange(r) : null
  }

  /** Mudanças ainda não revisadas nem revertidas, por created_at. */
  listUnreviewed(projectId: string, chatId?: string): FileChange[] {
    const rows = (
      chatId
        ? this.db
            .prepare(
              `select * from file_changes where project_id = ? and chat_id = ? and ${PENDING}
               order by created_at, rowid`
            )
            .all(projectId, chatId)
        : this.db
            .prepare(
              `select * from file_changes where project_id = ? and ${PENDING}
               order by created_at, rowid`
            )
            .all(projectId)
    ) as FileChangeRow[]
    return rows.map(toFileChange)
  }

  /** Mudanças não revisadas de um caminho, por created_at. */
  forPath(projectId: string, path: string): FileChange[] {
    const rows = this.db
      .prepare(
        `select * from file_changes where project_id = ? and path = ? and ${PENDING}
         order by created_at, rowid`
      )
      .all(projectId, path) as FileChangeRow[]
    return rows.map(toFileChange)
  }

  /** Chats (atribuídos) com mudanças não revisadas nem revertidas no caminho, sem repetição. */
  chatsWithUnreviewed(projectId: string, path: string): string[] {
    const rows = this.db
      .prepare(
        `select chat_id from file_changes
         where project_id = ? and path = ? and chat_id is not null and ${PENDING}
         group by chat_id order by min(created_at), min(rowid)`
      )
      .all(projectId, path) as { chat_id: string }[]
    return rows.map((r) => r.chat_id)
  }

  /** Última mudança registrada do caminho (qualquer estado), ou null. */
  lastForPath(projectId: string, path: string): FileChange | null {
    const r = this.db
      .prepare(
        `select * from file_changes where project_id = ? and path = ?
         order by created_at desc, rowid desc limit 1`
      )
      .get(projectId, path) as FileChangeRow | undefined
    return r ? toFileChange(r) : null
  }

  markReviewed(ids: string[]): void {
    this.mark('reviewed_at', ids)
  }

  markReverted(ids: string[]): void {
    this.mark('reverted_at', ids)
  }

  private mark(col: 'reviewed_at' | 'reverted_at', ids: string[]): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare(`update file_changes set ${col} = ? where id = ?`)
    const now = Date.now()
    this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id)
    })()
  }
}
