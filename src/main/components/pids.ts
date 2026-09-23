import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ComponentId } from '../../shared/components'

/** Processo iniciado pelo app ("gerenciado"). */
export interface PidEntry {
  pid: number
  startedAt: string
}
export type PidsMap = Partial<Record<ComponentId, PidEntry>>

function isEntry(v: unknown): v is PidEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.pid === 'number' && Number.isInteger(e.pid) && e.pid > 0
}

/** Lê `pids.json`; arquivo ausente ou corrompido → `{}`. Entradas inválidas são descartadas. */
export function readPids(file: string): PidsMap {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PidsMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((k === '9router' || k === 'llama') && isEntry(v)) {
      out[k] = { pid: v.pid, startedAt: typeof v.startedAt === 'string' ? v.startedAt : '' }
    }
  }
  return out
}

/** Grava de forma atômica (tmp + rename). */
export function writePids(file: string, pids: PidsMap): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(pids, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function setPid(file: string, id: ComponentId, pid: number): void {
  const pids = readPids(file)
  pids[id] = { pid, startedAt: new Date().toISOString() }
  writePids(file, pids)
}

/** Remove a entrada de `id`; com `pid`, só remove se ainda for esse PID. */
export function clearPid(file: string, id: ComponentId, pid?: number): void {
  const pids = readPids(file)
  const cur = pids[id]
  if (!cur || (pid !== undefined && cur.pid !== pid)) return
  delete pids[id]
  writePids(file, pids)
}
