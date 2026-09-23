import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EcosystemScope, SlashCommand } from '@shared/domain'
import { fmString, parseFrontmatter } from './frontmatter'
import { MtimeCache, expandHome, listFiles, pathKey } from './paths'
import { discoverSkills } from './skills'
import { listPlugins } from './plugins'

export const PROJECT_COMMAND_DIR = '.claude/commands'
const MAX_DESCRIPTION = 200

export interface EcosystemRoots {
  commandRoots: string[]
  skillRoots: string[]
  /** Raízes de plugins (`<marketplace>/<plugin>/<versão>/commands/*.md`, nome `<plugin>:<cmd>`). */
  pluginRoots?: string[]
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const t = line.replace(/^#+\s*/, '').trim()
  return t.length > MAX_DESCRIPTION ? t.slice(0, MAX_DESCRIPTION - 1) + '…' : t
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const cache = new MtimeCache<SlashCommand[]>()

function fileCommands(
  projectRoot: string,
  commandRoots: string[],
  pluginRoots: string[]
): SlashCommand[] {
  const key = JSON.stringify([pathKey(projectRoot), commandRoots, pluginRoots])
  return cache.get(key, () => {
    const deps: string[] = []
    const roots: { dir: string; scope: EcosystemScope; prefix: string }[] = [
      ...listPlugins(pluginRoots, deps).map((p) => ({
        dir: join(p.dir, 'commands'),
        scope: 'global' as const,
        prefix: `${p.plugin}:`
      })),
      ...commandRoots.map((r) => ({
        dir: resolve(expandHome(r)),
        scope: 'global' as const,
        prefix: ''
      })),
      {
        dir: join(resolve(projectRoot), PROJECT_COMMAND_DIR),
        scope: 'project' as const,
        prefix: ''
      }
    ]
    const out: SlashCommand[] = []
    for (const root of roots) {
      deps.push(root.dir)
      for (const file of listFiles(root.dir, '.md')) {
        const path = join(root.dir, file)
        deps.push(path)
        const raw = readText(path)
        if (raw === null) continue
        const { data, body } = parseFrontmatter(raw)
        out.push({
          name: root.prefix + file.slice(0, -3),
          description: fmString(data, 'description') || firstLine(body),
          source: 'command',
          path,
          scope: root.scope
        })
      }
    }
    return { value: out, deps }
  })
}

/**
 * Slash commands: skills viram `/<nome>`; depois os `.md` globais e os do projeto
 * (no mesmo nome, arquivo de comando vence skill e o projeto vence o global).
 */
export function listCommands(projectRoot: string, roots: EcosystemRoots): SlashCommand[] {
  const byName = new Map<string, SlashCommand>()
  for (const s of discoverSkills(projectRoot, roots.skillRoots, roots.pluginRoots ?? [])) {
    byName.set(s.name, {
      name: s.name,
      description: s.description,
      source: 'skill',
      path: s.path,
      scope: s.scope
    })
  }
  for (const c of fileCommands(projectRoot, roots.commandRoots, roots.pluginRoots ?? []))
    byName.set(c.name, c)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** `$ARGUMENTS` → args; sem o marcador e com args, anexa no fim. */
export function applyArguments(template: string, args: string): string {
  const a = args.trim()
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(a)
  if (!a) return template
  return `${template.replace(/\s+$/, '')}\n\n${a}`
}

/** Texto expandido de `/<name> <args>`; `null` se o comando não existe. */
export function expandCommand(
  projectRoot: string,
  roots: EcosystemRoots,
  name: string,
  args: string
): string | null {
  const n = name.trim().replace(/^\//, '')
  const cmd = listCommands(projectRoot, roots).find((c) => c.name === n)
  if (!cmd) return null
  if (cmd.source === 'skill') return `Use the skill "${cmd.name}". ${args.trim()}`.trim()
  const raw = readText(cmd.path)
  if (raw === null) return null
  return applyArguments(parseFrontmatter(raw).body.trim(), args)
}
