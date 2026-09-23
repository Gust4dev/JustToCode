import { resolve } from 'node:path'
import type { Project } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface ProjectRow {
  id: string
  path: string
  name: string
  created_at: number
  last_opened_at: number | null
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  path: r.path,
  name: r.name,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at
})

/** Normaliza um caminho para comparação: resolve, sem barra final; no Windows, `\` e minúsculas. */
export function normalizeProjectPath(p: string): string {
  const abs = resolve(p)
  if (process.platform !== 'win32') return abs.length > 1 ? abs.replace(/\/+$/, '') : abs
  return abs.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export class ProjectRepo {
  constructor(private db: Db) {}

  create(path: string, name: string): Project {
    const now = Date.now()
    const row: ProjectRow = {
      id: newId(),
      path: resolve(path),
      name,
      created_at: now,
      last_opened_at: now
    }
    this.db
      .prepare(
        `insert into projects (id, path, name, created_at, last_opened_at)
         values (@id, @path, @name, @created_at, @last_opened_at)`
      )
      .run(row)
    return toProject(row)
  }

  get(id: string): Project | null {
    const r = this.db.prepare('select * from projects where id = ?').get(id) as
      ProjectRow | undefined
    return r ? toProject(r) : null
  }

  getByPath(path: string): Project | null {
    const key = normalizeProjectPath(path)
    const rows = this.db.prepare('select * from projects').all() as ProjectRow[]
    const r = rows.find((row) => normalizeProjectPath(row.path) === key)
    return r ? toProject(r) : null
  }

  list(): Project[] {
    const rows = this.db
      .prepare(
        `select * from projects
         order by last_opened_at is null, last_opened_at desc, created_at desc, rowid desc`
      )
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  touch(id: string): void {
    this.db.prepare('update projects set last_opened_at = ? where id = ?').run(Date.now(), id)
  }

  remove(id: string): void {
    this.db.prepare('delete from projects where id = ?').run(id)
  }
}
