import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EcosystemScope } from '@shared/domain'
import { MtimeCache, SKIP_DIRS, expandHome, pathKey } from './paths'

export const PROJECT_RULE_DIR = '.claude/rules'
export const RULE_EXTS = ['.md', '.toml']
/** Profundidade máxima (pastas abaixo da raiz) percorrida em `rules/**`. */
export const RULE_MAX_DEPTH = 6

export interface RuleFile {
  path: string
  /** Caminho relativo à raiz, com `/` e sem extensão (nome padrão da regra). */
  rel: string
  scope: EcosystemScope
}

/**
 * Arquivos `.md`/`.toml` achados recursivamente em `dir` (ordem alfabética, pastas depois dos
 * arquivos). Ignora `node_modules`/`.git` e não segue symlinks. Acrescenta em `deps` as pastas
 * visitadas e os arquivos achados (cache por mtime).
 */
function walkRuleFiles(dir: string, deps: string[]): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = []
  const walk = (d: string, prefix: string, depth: number): void => {
    deps.push(d)
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const lower = e.name.toLowerCase()
      const ext = RULE_EXTS.find((x) => lower.endsWith(x))
      if (!e.isFile() || !ext) continue
      const path = join(d, e.name)
      deps.push(path)
      out.push({ path, rel: prefix + e.name.slice(0, -ext.length) })
    }
    if (depth >= RULE_MAX_DEPTH) return
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      walk(join(d, e.name), `${prefix}${e.name}/`, depth + 1)
    }
  }
  walk(dir, '', 0)
  return out
}

const cache = new MtimeCache<RuleFile[]>()

/**
 * Regras em arquivo: `<raiz global>/**` (config `ruleRoots`) e `<projeto>/.claude/rules/**`,
 * `.md` (frontmatter) ou `.toml`. Ordem: raízes globais na ordem da config, depois o projeto.
 */
export function discoverRuleFiles(projectRoot: string, ruleRoots: string[]): RuleFile[] {
  const key = JSON.stringify([pathKey(projectRoot), ruleRoots])
  return cache.get(key, () => {
    const deps: string[] = []
    const roots: { dir: string; scope: EcosystemScope }[] = [
      ...ruleRoots.map((r) => ({ dir: resolve(expandHome(r)), scope: 'global' as const })),
      { dir: join(resolve(projectRoot), PROJECT_RULE_DIR), scope: 'project' as const }
    ]
    const value: RuleFile[] = []
    for (const root of roots) {
      for (const f of walkRuleFiles(root.dir, deps)) value.push({ ...f, scope: root.scope })
    }
    return { value, deps }
  })
}
