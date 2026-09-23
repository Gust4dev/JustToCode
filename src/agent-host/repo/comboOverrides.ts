import type { Db } from '../db'

export interface ComboOverride {
  combo: string
  members: string[] | null
  ignored: string[]
  windowOverride: number | null
}

interface Row {
  combo: string
  members_json: string | null
  ignored_members_json: string | null
  window_override: number | null
}

const parseList = (json: string | null): string[] | null => {
  if (json == null) return null
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

export class ComboOverrideRepo {
  constructor(private db: Db) {}

  get(combo: string): ComboOverride | null {
    const r = this.db.prepare('select * from combo_overrides where combo = ?').get(combo) as
      Row | undefined
    if (!r) return null
    return {
      combo: r.combo,
      members: parseList(r.members_json),
      ignored: parseList(r.ignored_members_json) ?? [],
      windowOverride: r.window_override ?? null
    }
  }

  /** Atualiza só os campos presentes (`undefined` mantém; `null` limpa). */
  set(
    combo: string,
    patch: { members?: string[] | null; ignored?: string[]; windowOverride?: number | null }
  ): ComboOverride {
    const cur = this.get(combo) ?? { combo, members: null, ignored: [], windowOverride: null }
    const next: ComboOverride = {
      combo,
      members: patch.members === undefined ? cur.members : patch.members,
      ignored: patch.ignored === undefined ? cur.ignored : patch.ignored,
      windowOverride: patch.windowOverride === undefined ? cur.windowOverride : patch.windowOverride
    }
    this.db
      .prepare(
        `insert into combo_overrides (combo, members_json, ignored_members_json, window_override)
         values (?, ?, ?, ?)
         on conflict(combo) do update set members_json = excluded.members_json,
           ignored_members_json = excluded.ignored_members_json,
           window_override = excluded.window_override`
      )
      .run(
        combo,
        next.members ? JSON.stringify(next.members) : null,
        JSON.stringify(next.ignored),
        next.windowOverride
      )
    return next
  }
}
