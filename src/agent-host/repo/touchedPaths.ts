import type { Db } from '../db'

/** Caminhos (relativos ao projeto) tocados por um chat — base dos gatilhos `glob`. */
export class TouchedPathRepo {
  constructor(private db: Db) {}

  /** Idempotente. */
  add(chatId: string, path: string): void {
    this.db
      .prepare('insert or ignore into chat_touched_paths (chat_id, path) values (?, ?)')
      .run(chatId, path)
  }

  list(chatId: string): string[] {
    const rows = this.db
      .prepare('select path from chat_touched_paths where chat_id = ? order by rowid asc')
      .all(chatId) as { path: string }[]
    return rows.map((r) => r.path)
  }

  clear(chatId: string): void {
    this.db.prepare('delete from chat_touched_paths where chat_id = ?').run(chatId)
  }
}
