import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EcosystemScope, SlashCommand } from '@shared/domain'
import { formatOf, parseInstructionText } from './frontmatter'
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

/** Extensões aceitas para arquivos de comando. */
export const COMMAND_EXTS = ['.md', '.toml']

/**
 * Só os arquivos de comando `.md`/`.toml` (plugins, globais, projeto), sem as skills; lista
 * estável por cache. Nome: `command` do frontmatter/TOML ou o nome do arquivo.
 */
export function listFileCommands(
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
      const files = COMMAND_EXTS.flatMap((ext) => listFiles(root.dir, ext)).sort()
      for (const file of files) {
        const path = join(root.dir, file)
        deps.push(path)
        const raw = readText(path)
        if (raw === null) continue
        const { body, meta } = parseInstructionText(raw, formatOf(path))
        out.push({
          name: root.prefix + (meta.command ?? file.slice(0, file.lastIndexOf('.'))),
          description: meta.description ?? firstLine(body),
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
  for (const c of listFileCommands(projectRoot, roots.commandRoots, roots.pluginRoots ?? []))
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
  const format = formatOf(cmd.path)
  let body = parseInstructionText(raw, format).body.trim()
  // Gemini CLI: `{{args}}` é o marcador de argumentos.
  if (format === 'toml') body = body.split('{{args}}').join('$ARGUMENTS')
  return applyArguments(body, args)
}
