import type { Db } from '../db'
import { newId } from '../ids'

/** `task` = subagentes liberados no projeto (padrão `*`). */
export type RuleTool = 'shell' | 'edit' | 'task'

export interface PermissionRule {
  id: string
  projectId: string
  tool: RuleTool
  pattern: string
  decision: 'allow'
}

interface RuleRow {
  id: string
  project_id: string
  tool: string
  pattern: string
  decision: string
}

const toRule = (r: RuleRow): PermissionRule => ({
  id: r.id,
  projectId: r.project_id,
  tool: r.tool as RuleTool,
  pattern: r.pattern,
  decision: 'allow'
})

export class PermissionRuleRepo {
  constructor(private db: Db) {}

  /** Idempotente: não duplica a mesma regra (projeto + tool + pattern). */
  add(projectId: string, tool: RuleTool, pattern: string): PermissionRule {
    const existing = this.db
      .prepare('select * from permission_rules where project_id = ? and tool = ? and pattern = ?')
      .get(projectId, tool, pattern) as RuleRow | undefined
    if (existing) return toRule(existing)
    const id = newId()
    this.db
      .prepare(
        "insert into permission_rules (id, project_id, tool, pattern, decision) values (?, ?, ?, ?, 'allow')"
      )
      .run(id, projectId, tool, pattern)
    return { id, projectId, tool, pattern, decision: 'allow' }
  }

  list(projectId: string, tool?: RuleTool): PermissionRule[] {
    const rows = (
      tool
        ? this.db
            .prepare(
              'select * from permission_rules where project_id = ? and tool = ? order by rowid'
            )
            .all(projectId, tool)
        : this.db
            .prepare('select * from permission_rules where project_id = ? order by rowid')
            .all(projectId)
    ) as RuleRow[]
    return rows.map(toRule)
  }
}
