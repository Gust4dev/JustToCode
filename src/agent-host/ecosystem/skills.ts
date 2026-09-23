import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EcosystemScope, SkillInfo } from '@shared/domain'
import { fmString, parseFrontmatter } from './frontmatter'
import { MtimeCache, expandHome, findMarkerFiles, pathKey } from './paths'
import { listPlugins } from './plugins'

export const PROJECT_SKILL_DIRS = ['.claude/skills', '.agents/skills']
/** Profundidade máxima (em pastas abaixo da raiz) onde um `SKILL.md` é procurado. */
export const SKILL_MAX_DEPTH = 4

export interface SkillRoot {
  dir: string
  scope: EcosystemScope
}

/** Raízes na ordem de precedência crescente: globais da config, depois as do projeto. */
export function skillRootsFor(projectRoot: string, globalRoots: string[]): SkillRoot[] {
  return [
    ...globalRoots.map((r) => ({ dir: resolve(expandHome(r)), scope: 'global' as const })),
    ...PROJECT_SKILL_DIRS.map((r) => ({
      dir: join(resolve(projectRoot), r),
      scope: 'project' as const
    }))
  ]
}

function readSkill(path: string, scope: EcosystemScope, prefix = ''): SkillInfo | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const { data } = parseFrontmatter(raw)
  const name = fmString(data, 'name') || basename(dirname(path))
  return { name: prefix + name, description: fmString(data, 'description'), path, scope }
}

const cache = new MtimeCache<SkillInfo[]>()

/**
 * Skills: `SKILL.md` achados recursivamente (até 4 níveis) nas raízes globais, nas do projeto
 * (`.claude/skills`, `.agents/skills`) e em `skills/` da versão mais recente de cada plugin
 * (nome `<plugin>:<skill>`). Mesmo nome: o projeto vence o global (a raiz posterior vence).
 */
export function discoverSkills(
  projectRoot: string,
  globalRoots: string[],
  pluginRoots: string[] = []
): SkillInfo[] {
  const key = JSON.stringify([pathKey(projectRoot), globalRoots, pluginRoots])
  return cache.get(key, () => {
    const deps: string[] = []
    const byName = new Map<string, SkillInfo>()
    for (const p of listPlugins(pluginRoots, deps)) {
      for (const file of findMarkerFiles(
        join(p.dir, 'skills'),
        'SKILL.md',
        SKILL_MAX_DEPTH,
        deps
      )) {
        const skill = readSkill(file, 'global', `${p.plugin}:`)
        if (skill) byName.set(skill.name, skill)
      }
    }
    for (const root of skillRootsFor(projectRoot, globalRoots)) {
      for (const file of findMarkerFiles(root.dir, 'SKILL.md', SKILL_MAX_DEPTH, deps)) {
        const skill = readSkill(file, root.scope)
        if (skill) byName.set(skill.name, skill)
      }
    }
    const value = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { value, deps }
  })
}

export function findSkill(
  projectRoot: string,
  globalRoots: string[],
  name: string,
  pluginRoots: string[] = []
): SkillInfo | null {
  const n = name.trim().replace(/^\//, '')
  return discoverSkills(projectRoot, globalRoots, pluginRoots).find((s) => s.name === n) ?? null
}

/** Corpo da skill (sem frontmatter) + a pasta dela. */
export function loadSkillBody(skill: SkillInfo): { body: string; dir: string } {
  const raw = readFileSync(skill.path, 'utf8')
  return { body: parseFrontmatter(raw).body, dir: dirname(skill.path) }
}
