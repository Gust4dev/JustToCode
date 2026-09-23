import Database from 'better-sqlite3'
import { migrations } from './migrations'

export type Db = Database.Database

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const current = db.pragma('user_version', { simple: true }) as number
  const apply = db.transaction(() => {
    for (let i = current; i < migrations.length; i++) db.exec(migrations[i])
    db.pragma(`user_version = ${migrations.length}`)
  })
  if (current < migrations.length) apply()
  return db
}

export function listTables(db: Db): string[] {
  const rows = db
    .prepare("select name from sqlite_master where type='table' order by name")
    .all() as { name: string }[]
  return rows.map((r) => r.name)
}
