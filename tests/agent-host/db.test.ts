import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
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

  it('migração 5 cria as tabelas e colunas do ciclo 2', () => {
    const db = openDb(tmp())
    expect(migrations.length).toBeGreaterThanOrEqual(5)
    const cols = (t: string): string[] =>
      (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    const tables = listTables(db)
    for (const t of [
      'chat_groups',
      'queued_messages',
      'chat_queue_state',
      'instructions',
      'instruction_toggles',
      'chat_touched_paths'
    ]) {
      expect(tables).toContain(t)
    }
    expect(cols('chats')).toEqual(
      expect.arrayContaining([
        'group_id',
        'continued_from_chat_id',
        'max_iterations',
        'token_budget',
        'settings_json',
        'last_reported_model'
      ])
    )
    const idx = (
      db
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'instructions'"
        )
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(idx).toEqual(expect.arrayContaining(['instructions_by_scope', 'instructions_by_kind']))
    db.prepare('insert into projects (id, path, name, created_at) values (?, ?, ?, ?)').run(
      'p',
      'x',
      'p',
      1
    )
    db.prepare(
      'insert into chats (id, project_id, title, color, combo, created_at) values (?, ?, ?, ?, ?, ?)'
    ).run('c', 'p', 't', '#fff', 'c', 1)
    expect(db.prepare("select max_iterations from chats where id = 'c'").get()).toEqual({
      max_iterations: 50
    })
    db.close()
  })

  it('migração 5 sobre um banco v4 preserva os chats existentes', () => {
    const f = tmp()
    const v4 = new Database(f)
    for (const m of migrations.slice(0, 4)) v4.exec(m)
    v4.pragma('user_version = 4')
    v4.prepare("insert into projects (id, path, name, created_at) values ('p', 'x', 'p', 1)").run()
    v4.prepare(
      "insert into chats (id, project_id, title, color, combo, created_at) values ('c', 'p', 't', '#fff', 'k', 1)"
    ).run()
    v4.close()
    const db = openDb(f)
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length)
    expect(
      db
        .prepare(
          "select title, group_id, max_iterations, token_budget, settings_json from chats where id = 'c'"
        )
        .get()
    ).toEqual({
      title: 't',
      group_id: null,
      max_iterations: 50,
      token_budget: null,
      settings_json: null
    })
    db.close()
  })

  it('migração 6 cria os triggers e apaga instruções órfãs de um banco v5', () => {
    const f = tmp()
    const v5 = new Database(f)
    for (const m of migrations.slice(0, 5)) v5.exec(m)
    v5.pragma('user_version = 5')
    v5.prepare("insert into projects (id, path, name, created_at) values ('p', 'x', 'p', 1)").run()
    const ins = v5.prepare(
      `insert into instructions (id, kind, scope, scope_id, name, trigger, body, source_json,
         created_at, updated_at) values (?, 'rule', ?, ?, ?, 'always', 'b', '{"type":"app"}', 1, 1)`
    )
    ins.run('ok-p', 'project', 'p', 'ok-p')
    ins.run('ok-g', 'global', null, 'ok-g')
    ins.run('orf-p', 'project', 'sumiu', 'orf-p')
    ins.run('orf-g', 'group', 'sumiu', 'orf-g')
    ins.run('orf-c', 'chat', 'sumiu', 'orf-c')
    v5.close()
    const db = openDb(f)
    expect(migrations.length).toBeGreaterThanOrEqual(6)
    const ids = (
      db.prepare('select id from instructions order by id').all() as { id: string }[]
    ).map((r) => r.id)
    expect(ids).toEqual(['ok-g', 'ok-p'])
    const triggers = (
      db.prepare("select name from sqlite_master where type = 'trigger'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(triggers).toEqual(
      expect.arrayContaining([
        'instructions_cleanup_project',
        'instructions_cleanup_group',
        'instructions_cleanup_chat'
      ])
    )
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
