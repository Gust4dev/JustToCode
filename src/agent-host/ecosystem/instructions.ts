import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { EcosystemScope, InstructionFile } from '@shared/domain'
import { MtimeCache, expandHome, isFile, pathKey } from './paths'

export const MAX_IMPORT_DEPTH = 5
export const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

export interface LoadedInstructions {
  files: InstructionFile[]
  text: string
}

const IMPORT_LINE = /^\s*@(\S+)\s*$/

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

function resolveImport(spec: string, fromFile: string): string {
  const expanded = expandHome(spec)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(dirname(fromFile), expanded)
}

function compute(
  projectRoot: string,
  globalFiles: string[]
): LoadedInstructions & { deps: string[] } {
  const files: InstructionFile[] = []
  const seen = new Set<string>()
  const deps: string[] = []

  /** Lê um arquivo e expande as linhas `@caminho`; `null` se ausente ou repetido. */
  const load = (path: string, scope: EcosystemScope, depth: number): string | null => {
    const key = pathKey(path)
    if (seen.has(key)) return null
    deps.push(path)
    if (!isFile(path)) return null
    const raw = readText(path)
    if (raw === null) return null
    seen.add(key)
    files.push({ path, scope, bytes: Buffer.byteLength(raw, 'utf8') })
    const out: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      const m = IMPORT_LINE.exec(line)
      if (!m || depth >= MAX_IMPORT_DEPTH) {
        out.push(line)
        continue
      }
      const target = resolveImport(m[1], path)
      if (seen.has(pathKey(target))) continue // ciclo ou repetido: já está no texto
      const sub = load(target, scope, depth + 1)
      // Ausente: mantém a linha original (sem erro).
      out.push(sub === null ? line : sub.replace(/\s+$/, ''))
    }
    return out.join('\n')
  }

  const sections: string[] = []
  const top: { path: string; scope: EcosystemScope }[] = [
    ...globalFiles.map((f) => ({ path: resolve(expandHome(f)), scope: 'global' as const })),
    ...PROJECT_INSTRUCTION_FILES.map((f) => ({
      path: join(resolve(projectRoot), f),
      scope: 'project' as const
    }))
  ]
  for (const t of top) {
    const text = load(t.path, t.scope, 0)
    if (text !== null && text.trim()) sections.push(`Contents of ${t.path}:\n\n${text.trim()}`)
  }
  return { files, text: sections.join('\n\n'), deps }
}

const cache = new MtimeCache<LoadedInstructions>()

/**
 * Instruções globais (na ordem da config) + `AGENTS.md`/`CLAUDE.md` da raiz do projeto,
 * com imports `@caminho` resolvidos (até 5 níveis, sem ciclos). Somente leitura.
 */
export function loadInstructions(projectRoot: string, globalFiles: string[]): LoadedInstructions {
  const key = JSON.stringify([pathKey(projectRoot), globalFiles])
  return cache.get(key, () => {
    const { files, text, deps } = compute(projectRoot, globalFiles)
    return { value: { files, text }, deps }
  })
}
