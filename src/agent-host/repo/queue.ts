import type { AttachmentMeta, QueuedMessage, QueueState } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface QueueRow {
  id: string
  chat_id: string
  text: string
  attachments_json: string
  position: number
  created_at: number
}

const toItem = (r: QueueRow): QueuedMessage => ({
  id: r.id,
  chatId: r.chat_id,
  text: r.text,
  attachments: JSON.parse(r.attachments_json) as AttachmentMeta[],
  position: r.position,
  createdAt: r.created_at
})

/** Fila de mensagens por chat (FIFO por `position`) + estado de pausa. */
export class QueueRepo {
  constructor(private db: Db) {}

  enqueue(chatId: string, text: string, attachments: AttachmentMeta[] = []): QueuedMessage {
    const { next } = this.db
      .prepare(
        'select coalesce(max(position), -1) + 1 as next from queued_messages where chat_id = ?'
      )
      .get(chatId) as { next: number }
    const row: QueueRow = {
      id: newId(),
      chat_id: chatId,
      text,
      attachments_json: JSON.stringify(attachments),
      position: next,
      created_at: Date.now()
    }
    this.db
      .prepare(
        `insert into queued_messages (id, chat_id, text, attachments_json, position, created_at)
         values (@id, @chat_id, @text, @attachments_json, @position, @created_at)`
      )
      .run(row)
    return toItem(row)
  }

  get(id: string): QueuedMessage | null {
    const r = this.db.prepare('select * from queued_messages where id = ?').get(id) as
      QueueRow | undefined
    return r ? toItem(r) : null
  }

  list(chatId: string): QueuedMessage[] {
    const rows = this.db
      .prepare('select * from queued_messages where chat_id = ? order by position asc, rowid asc')
      .all(chatId) as QueueRow[]
    return rows.map(toItem)
  }

  /** Primeiro da fila, sem remover. */
  peek(chatId: string): QueuedMessage | null {
    const r = this.db
      .prepare(
        'select * from queued_messages where chat_id = ? order by position asc, rowid asc limit 1'
      )
      .get(chatId) as QueueRow | undefined
    return r ? toItem(r) : null
  }

  /** Remove e devolve o primeiro da fila. */
  shift(chatId: string): QueuedMessage | null {
    const first = this.peek(chatId)
    if (first) this.remove(first.id)
    return first
  }

  remove(id: string): void {
    this.db.prepare('delete from queued_messages where id = ?').run(id)
  }

  editText(id: string, text: string): QueuedMessage {
    const r = this.db.prepare('update queued_messages set text = ? where id = ?').run(text, id)
    if (r.changes === 0) throw new Error(`Item da fila não encontrado: ${id}`)
    return this.get(id) as QueuedMessage
  }

  clear(chatId: string): void {
    this.db.prepare('delete from queued_messages where chat_id = ?').run(chatId)
  }

  setPaused(chatId: string, paused: boolean, reason: string | null = null): void {
    this.db
      .prepare(
        `insert into chat_queue_state (chat_id, paused, pause_reason) values (?, ?, ?)
         on conflict(chat_id) do update set paused = excluded.paused,
           pause_reason = excluded.pause_reason`
      )
      .run(chatId, paused ? 1 : 0, paused ? reason : null)
  }

  state(chatId: string): QueueState {
    const s = this.db
      .prepare('select paused, pause_reason from chat_queue_state where chat_id = ?')
      .get(chatId) as { paused: number; pause_reason: string | null } | undefined
    return {
      chatId,
      paused: s?.paused === 1,
      pauseReason: s?.paused === 1 ? s.pause_reason : null,
      items: this.list(chatId)
    }
  }
}
