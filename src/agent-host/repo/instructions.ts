import type {
  Instruction,
  InstructionKind,
  InstructionScope,
  InstructionSource,
  InstructionTrigger,
  MemoryOrigin
} from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface InstructionRow {
  id: string
  kind: string
  scope: string
  scope_id: string | null
  name: string
  description: string
  trigger: string
  globs_json: string
  body: string
  format: string
  source_json: string
  enabled: number
  origin_json: string | null
  created_at: number
  updated_at: number
}

/** Descobertos (arquivo/plugin) e instalados do GitHub são somente leitura: só liga/desliga. */
export const isReadonlySource = (s: InstructionSource): boolean =>
  s.type === 'file' || s.type === 'plugin' || s.type === 'github'

const toInstruction = (r: InstructionRow): Instruction => {
  const source = JSON.parse(r.source_json) as InstructionSource
  return {
    id: r.id,
    kind: r.kind as InstructionKind,
    scope: r.scope as InstructionScope,
    scopeId: r.scope_id,
    name: r.name,
    description: r.description,
    trigger: r.trigger as InstructionTrigger,
    globs: JSON.parse(r.globs_json) as string[],
    body: r.body,
    format: r.format as 'md' | 'toml',
    source,
    enabled: r.enabled === 1,
    readonly: isReadonlySource(source),
    origin: r.origin_json ? (JSON.parse(r.origin_json) as MemoryOrigin) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

type EditableField =
  | 'kind'
  | 'scope'
  | 'scopeId'
  | 'name'
  | 'description'
  | 'trigger'
  | 'globs'
  | 'body'
  | 'format'
  | 'source'
  | 'enabled'
  | 'origin'

export type InstructionInput = Pick<Instruction, 'kind' | 'scope' | 'name' | 'trigger' | 'body'> &
  Partial<Pick<Instruction, EditableField>>

export type InstructionPatch = Partial<Pick<Instruction, EditableField>>

export interface InstructionFilter {
  scope?: InstructionScope
  /** Só vale junto de `scope`; `null` casa `scope_id is null`. */
  scopeId?: string | null
  kind?: InstructionKind
}

/** Contexto de um chat: global + projeto + grupo + chat que casarem. */
export interface InstructionContext {
  projectId?: string | null
  groupId?: string | null
  chatId?: string | null
  kind?: InstructionKind
}

const ORDER = `order by case scope when 'global' then 0 when 'project' then 1 when 'group' then 2
  else 3 end, name asc, created_at asc, rowid asc`

export class InstructionRepo {
  constructor(private db: Db) {}

  create(i: InstructionInput): Instruction {
    const now = Date.now()
    const row: InstructionRow = {
      id: newId(),
      kind: i.kind,
      scope: i.scope,
      scope_id: i.scope === 'global' ? null : (i.scopeId ?? null),
      name: i.name,
      description: i.description ?? '',
      trigger: i.trigger,
      globs_json: JSON.stringify(i.globs ?? []),
      body: i.body,
      format: i.format ?? 'md',
      source_json: JSON.stringify(i.source ?? { type: 'app' }),
      enabled: i.enabled === false ? 0 : 1,
      origin_json: i.origin ? JSON.stringify(i.origin) : null,
      created_at: now,
      updated_at: now
    }
    this.db
      .prepare(
        `insert into instructions (id, kind, scope, scope_id, name, description, trigger,
           globs_json, body, format, source_json, enabled, origin_json, created_at, updated_at)
         values (@id, @kind, @scope, @scope_id, @name, @description, @trigger, @globs_json, @body,
           @format, @source_json, @enabled, @origin_json, @created_at, @updated_at)`
      )
      .run(row)
    return toInstruction(row)
  }

  get(id: string): Instruction | null {
    const r = this.db.prepare('select * from instructions where id = ?').get(id) as
      InstructionRow | undefined
    return r ? toInstruction(r) : null
  }

  update(id: string, p: InstructionPatch): Instruction {
    const cur = this.get(id)
    if (!cur) throw new Error(`Instrução não encontrada: ${id}`)
    const next: Instruction = { ...cur, ...p }
    this.db
      .prepare(
        `update instructions set kind = ?, scope = ?, scope_id = ?, name = ?, description = ?,
           trigger = ?, globs_json = ?, body = ?, format = ?, source_json = ?, enabled = ?,
           origin_json = ?, updated_at = ? where id = ?`
      )
      .run(
        next.kind,
        next.scope,
        next.scope === 'global' ? null : next.scopeId,
        next.name,
        next.description,
        next.trigger,
        JSON.stringify(next.globs),
        next.body,
        next.format,
        JSON.stringify(next.source),
        next.enabled ? 1 : 0,
        next.origin ? JSON.stringify(next.origin) : null,
        Math.max(Date.now(), cur.updatedAt + 1),
        id
      )
    return this.get(id) as Instruction
  }

  setEnabled(id: string, enabled: boolean): Instruction {
    return this.update(id, { enabled })
  }

  remove(id: string): void {
    this.db.prepare('delete from instructions where id = ?').run(id)
  }

  list(f: InstructionFilter = {}): Instruction[] {
    const where: string[] = []
    const args: unknown[] = []
    if (f.scope) {
      where.push('scope = ?')
      args.push(f.scope)
      if (f.scopeId === null) where.push('scope_id is null')
      else if (f.scopeId !== undefined) {
        where.push('scope_id = ?')
        args.push(f.scopeId)
      }
    }
    if (f.kind) {
      where.push('kind = ?')
      args.push(f.kind)
    }
    const cond = where.length ? `where ${where.join(' and ')}` : ''
    return (
      this.db
        .prepare(`select * from instructions ${cond} ${ORDER}`)
        .all(...args) as InstructionRow[]
    ).map(toInstruction)
  }

  /** Global + os escopos informados (projeto/grupo/chat), na ordem global → chat. */
  listForContext(c: InstructionContext): Instruction[] {
    const ors = ["scope = 'global'"]
    const args: unknown[] = []
    const add = (scope: InstructionScope, id: string | null | undefined): void => {
      if (!id) return
      ors.push('(scope = ? and scope_id = ?)')
      args.push(scope, id)
    }
    add('project', c.projectId)
    add('group', c.groupId)
    add('chat', c.chatId)
    let sql = `select * from instructions where (${ors.join(' or ')})`
    if (c.kind) {
      sql += ' and kind = ?'
      args.push(c.kind)
    }
    return (this.db.prepare(`${sql} ${ORDER}`).all(...args) as InstructionRow[]).map(toInstruction)
  }

  // Toggles de instruções descobertas (arquivo/plugin), pelo id estável delas.

  /** `null` = sem override (vale o padrão do descoberto). */
  getToggle(instructionId: string): boolean | null {
    const r = this.db
      .prepare('select enabled from instruction_toggles where instruction_id = ?')
      .get(instructionId) as { enabled: number } | undefined
    return r ? r.enabled === 1 : null
  }

  setToggle(instructionId: string, enabled: boolean): void {
    this.db
      .prepare(
        `insert into instruction_toggles (instruction_id, enabled) values (?, ?)
         on conflict(instruction_id) do update set enabled = excluded.enabled`
      )
      .run(instructionId, enabled ? 1 : 0)
  }

  clearToggle(instructionId: string): void {
    this.db.prepare('delete from instruction_toggles where instruction_id = ?').run(instructionId)
  }

  toggles(): Map<string, boolean> {
    const rows = this.db
      .prepare('select instruction_id, enabled from instruction_toggles')
      .all() as { instruction_id: string; enabled: number }[]
    return new Map(rows.map((r) => [r.instruction_id, r.enabled === 1]))
  }
}
