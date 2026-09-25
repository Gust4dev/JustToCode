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

/** Um arquivo de topo (global da config ou `AGENTS.md`/`CLAUDE.md` do projeto) já expandido. */
export interface InstructionSection {
  path: string
  scope: EcosystemScope
  /** Texto com imports resolvidos, sem espaços nas pontas (nunca vazio). */
  text: string
}

/** Formato de cada seção no prompt (igual ao `text` de `loadInstructions`). */
export const sectionText = (path: string, text: string): string => `Contents of ${path}:\n\n${text}`

interface Computed extends LoadedInstructions {
  sections: InstructionSection[]
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

function compute(projectRoot: string, globalFiles: string[]): Computed & { deps: string[] } {
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

  const sections: InstructionSection[] = []
  const top: { path: string; scope: EcosystemScope }[] = [
    ...globalFiles.map((f) => ({ path: resolve(expandHome(f)), scope: 'global' as const })),
    ...PROJECT_INSTRUCTION_FILES.map((f) => ({
      path: join(resolve(projectRoot), f),
      scope: 'project' as const
    }))
  ]
  for (const t of top) {
    const text = load(t.path, t.scope, 0)
    if (text !== null && text.trim())
      sections.push({ path: t.path, scope: t.scope, text: text.trim() })
  }
  const joined = sections.map((x) => sectionText(x.path, x.text)).join('\n\n')
  return { files, text: joined, sections, deps }
}

const cache = new MtimeCache<Computed>()

function computeCached(projectRoot: string, globalFiles: string[]): Computed {
  const key = JSON.stringify([pathKey(projectRoot), globalFiles])
  return cache.get(key, () => {
    const { deps, ...value } = compute(projectRoot, globalFiles)
    return { value, deps }
  })
}

/**
 * Instruções globais (na ordem da config) + `AGENTS.md`/`CLAUDE.md` da raiz do projeto,
 * com imports `@caminho` resolvidos (até 5 níveis, sem ciclos). Somente leitura.
 */
export function loadInstructions(projectRoot: string, globalFiles: string[]): LoadedInstructions {
  const { files, text } = computeCached(projectRoot, globalFiles)
  return { files, text }
}

/**
 * Mesmos arquivos de `loadInstructions`, separados por arquivo de topo (imports já dentro do texto
 * de quem importou; cada arquivo entra uma vez só). A lista devolvida é a mesma enquanto o cache
 * por mtime não invalidar (serve de chave de memo).
 */
export function loadInstructionSections(
  projectRoot: string,
  globalFiles: string[]
): InstructionSection[] {
  return computeCached(projectRoot, globalFiles).sections
}
