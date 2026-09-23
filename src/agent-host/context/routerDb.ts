import Database from 'better-sqlite3'
import { join } from 'node:path'

/** Caminho padrão do banco do 9router local. */
export function defaultRouterDbPath(): string {
  return join(process.env.APPDATA ?? '', '9router', 'db', 'data.sqlite')
}

const shortError = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg
}

/**
 * Lê as combos do 9router (somente leitura; só a tabela `combos`).
 * Nunca lança: qualquer erro vira `{ combos: {}, error }`. Fecha o banco sempre.
 */
export function readRouterCombos(path: string): {
  combos: Record<string, string[]>
  error: string | null
} {
  let db: Database.Database | null = null
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    const rows = db.prepare('select name, models from combos').all() as {
      name: unknown
      models: unknown
    }[]
    const combos: Record<string, string[]> = {}
    for (const r of rows) {
      if (typeof r.name !== 'string') continue
      const parsed: unknown = JSON.parse(String(r.models ?? '[]'))
      if (!Array.isArray(parsed)) throw new Error(`models inválido na combo ${r.name}`)
      combos[r.name] = parsed.filter((m): m is string => typeof m === 'string')
    }
    return { combos, error: null }
  } catch (e) {
    return { combos: {}, error: shortError(e) }
  } finally {
    try {
      db?.close()
    } catch {
      // ignora
    }
  }
}
