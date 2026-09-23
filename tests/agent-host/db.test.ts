import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, listTables } from '../../src/agent-host/db'
import { migrations } from '../../src/agent-host/db/migrations'

const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'jtc-db-')), 'test.sqlite')

describe('openDb', () => {
  it('aplica todas as migrações e cria as tabelas do spec', () => {
    const db = openDb(tmp())
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length)
    const tables = listTables(db)
    for (const t of [
      'projects',
      'chats',
      'messages',
      'attachments',
      'requests',
      'compactions',
      'tool_calls',
      'file_changes',
      'approvals',
      'permission_rules',
      'combo_overrides',
      'model_windows'
    ]) {
      expect(tables).toContain(t)
    }
    db.close()
  })

  it('migração 2 acrescenta as colunas da F1', () => {
    const db = openDb(tmp())
    const cols = (t: string): string[] =>
      (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(migrations.length).toBeGreaterThanOrEqual(2)
    expect(cols('tool_calls')).toEqual(expect.arrayContaining(['model_call_id', 'output_preview']))
    expect(cols('attachments')).toContain('name')
    expect(cols('approvals')).toContain('project_id')
    db.close()
  })

  it("migração 3 acrescenta messages.kind com padrão 'message'", () => {
    const db = openDb(tmp())
    expect(migrations.length).toBeGreaterThanOrEqual(3)
    const col = (
      db.prepare('pragma table_info(messages)').all() as {
        name: string
        notnull: number
        dflt_value: string | null
      }[]
    ).find((c) => c.name === 'kind')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(1)
    expect(col?.dflt_value).toBe("'message'")
    db.prepare('insert into projects (id, path, name, created_at) values (?, ?, ?, ?)').run(
      'p',
      'x',
      'p',
      1
    )
    db.prepare(
      'insert into chats (id, project_id, title, color, combo, created_at) values (?, ?, ?, ?, ?, ?)'
    ).run('c', 'p', 't', '#fff', 'c', 1)
    db.prepare(
      `insert into messages (id, chat_id, seq, role, content_json, created_at)
       values ('m', 'c', 1, 'user', '{}', 1)`
    ).run()
    expect(db.prepare("select kind from messages where id = 'm'").get()).toEqual({
      kind: 'message'
    })
    db.close()
  })

  it('migração 4 cria o índice chats_by_parent', () => {
    const db = openDb(tmp())
    expect(migrations.length).toBeGreaterThanOrEqual(4)
    const idx = db
      .prepare("select name, tbl_name from sqlite_master where type = 'index' and name = ?")
      .get('chats_by_parent')
    expect(idx).toEqual({ name: 'chats_by_parent', tbl_name: 'chats' })
    const cols = (db.prepare('pragma index_info(chats_by_parent)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toEqual(['parent_chat_id'])
    db.close()
  })

  it('é idempotente ao reabrir', () => {
    const f = tmp()
    openDb(f).close()
    const db = openDb(f)
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length)
    db.close()
  })

  it('liga WAL e foreign keys', () => {
    const db = openDb(tmp())
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })
})
