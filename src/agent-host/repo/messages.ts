import type { AttachmentMeta, ChatMessage, MessageKind, StoredMessage } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface MessageRow {
  id: string
  chat_id: string
  seq: number
  role: string
  content_json: string
  token_est: number | null
  model_used: string | null
  request_id: string | null
  compacted: number
  kind: string
  created_at: number
}

interface AttachmentRow {
  id: string
  message_id: string
  kind: string
  name: string
  blob_hash: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
}

const toAttachment = (r: AttachmentRow): AttachmentMeta => ({
  id: r.id,
  kind: r.kind as AttachmentMeta['kind'],
  name: r.name,
  blobHash: r.blob_hash,
  mime: r.mime,
  bytes: r.bytes,
  width: r.width,
  height: r.height
})

const toMessage = (r: MessageRow, attachments: AttachmentMeta[]): StoredMessage => ({
  id: r.id,
  chatId: r.chat_id,
  seq: r.seq,
  message: JSON.parse(r.content_json) as ChatMessage,
  tokenEst: r.token_est,
  modelUsed: r.model_used,
  requestId: r.request_id,
  compacted: r.compacted === 1,
  kind: r.kind === 'summary' ? 'summary' : 'message',
  createdAt: r.created_at,
  attachments
})

export class MessageRepo {
  constructor(private db: Db) {}

  append(
    chatId: string,
    message: ChatMessage,
    extra?: { tokenEst?: number; modelUsed?: string; requestId?: string; kind?: MessageKind }
  ): StoredMessage {
    const insert = this.db.transaction((): MessageRow => {
      const { seq } = this.db
        .prepare('select coalesce(max(seq), 0) + 1 as seq from messages where chat_id = ?')
        .get(chatId) as { seq: number }
      const row: MessageRow = {
        id: newId(),
        chat_id: chatId,
        seq,
        role: message.role,
        content_json: JSON.stringify(message),
        token_est: extra?.tokenEst ?? null,
        model_used: extra?.modelUsed ?? null,
        request_id: extra?.requestId ?? null,
        compacted: 0,
        kind: extra?.kind ?? 'message',
        created_at: Date.now()
      }
      this.db
        .prepare(
          `insert into messages (id, chat_id, seq, role, content_json, token_est, model_used,
             request_id, compacted, kind, created_at)
           values (@id, @chat_id, @seq, @role, @content_json, @token_est, @model_used,
             @request_id, @compacted, @kind, @created_at)`
        )
        .run(row)
      return row
    })
    return toMessage(insert(), [])
  }

  addAttachment(messageId: string, a: Omit<AttachmentMeta, 'id'>): AttachmentMeta {
    const row: AttachmentRow = {
      id: newId(),
      message_id: messageId,
      kind: a.kind,
      name: a.name,
      blob_hash: a.blobHash,
      mime: a.mime,
      bytes: a.bytes,
      width: a.width,
      height: a.height
    }
    this.db
      .prepare(
        `insert into attachments (id, message_id, kind, name, blob_hash, mime, bytes, width, height)
         values (@id, @message_id, @kind, @name, @blob_hash, @mime, @bytes, @width, @height)`
      )
      .run(row)
    return toAttachment(row)
  }

  list(chatId: string, opts?: { includeCompacted?: boolean }): StoredMessage[] {
    const sql = opts?.includeCompacted
      ? 'select * from messages where chat_id = ? order by seq'
      : 'select * from messages where chat_id = ? and compacted = 0 order by seq'
    const rows = this.db.prepare(sql).all(chatId) as MessageRow[]
    const atts = this.db
      .prepare(
        `select a.* from attachments a join messages m on m.id = a.message_id
         where m.chat_id = ? order by a.rowid`
      )
      .all(chatId) as AttachmentRow[]
    const byMsg = new Map<string, AttachmentMeta[]>()
    for (const a of atts) {
      const list = byMsg.get(a.message_id) ?? []
      list.push(toAttachment(a))
      byMsg.set(a.message_id, list)
    }
    return rows.map((r) => toMessage(r, byMsg.get(r.id) ?? []))
  }

  /** Marca as mensagens como compactadas (nunca apaga). */
  markCompacted(chatId: string, seqs: number[]): void {
    if (seqs.length === 0) return
    const stmt = this.db.prepare('update messages set compacted = 1 where chat_id = ? and seq = ?')
    this.db.transaction(() => {
      for (const seq of seqs) stmt.run(chatId, seq)
    })()
  }

  get(id: string): StoredMessage | null {
    const r = this.db.prepare('select * from messages where id = ?').get(id) as
      MessageRow | undefined
    if (!r) return null
    const atts = this.db
      .prepare('select * from attachments where message_id = ? order by rowid')
      .all(id) as AttachmentRow[]
    return toMessage(r, atts.map(toAttachment))
  }
}
