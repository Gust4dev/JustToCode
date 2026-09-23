import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AgentDefinition, EcosystemScope } from '@shared/domain'
import { fmString, parseFrontmatter } from './frontmatter'
import { MtimeCache, expandHome, isFile, listFiles, pathKey } from './paths'

export const PROJECT_AGENT_DIR = '.claude/agents'
export const GENERAL_AGENT = 'general'

/** Agente implícito: todas as ferramentas (menos `task`), combo do pai, sem prompt próprio. */
export const GENERAL_DEFINITION: AgentDefinition = {
  name: GENERAL_AGENT,
  description: 'General-purpose agent for multi-step tasks (research, searching code, editing).',
  tools: null,
  combo: null,
  path: '',
  scope: 'global'
}

/** Nomes de ferramentas do Claude Code → ferramentas do JustToCode. */
const TOOL_ALIASES: Record<string, string[]> = {
  read: ['read_file'],
  write: ['write_file'],
  edit: ['edit_file'],
  multiedit: ['edit_file'],
  glob: ['glob'],
  grep: ['grep'],
  ls: ['list_dir'],
  bash: ['shell'],
  powershell: ['shell']
}

function toolList(v: unknown): string[] | null {
  if (v === undefined || v === null || v === '') return null
  const raw = Array.isArray(v) ? v.map(String) : String(v).split(',')
  const list = raw.map((s) => s.trim()).filter(Boolean)
  return list.length ? list : null
}

function readAgent(path: string, scope: EcosystemScope): AgentDefinition | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const { data } = parseFrontmatter(raw)
  const name = fmString(data, 'name') || basename(path).replace(/\.md$/i, '')
  const combo = fmString(data, 'combo')
  return {
    name,
    description: fmString(data, 'description'),
    tools: toolList(data.tools),
    combo: combo || null,
    path,
    scope
  }
}

const cache = new MtimeCache<AgentDefinition[]>()

/**
 * Definições em `<raiz>/*.md` (raízes globais da config + `<projeto>/.claude/agents`).
 * Mesmo nome: o projeto vence o global. Não inclui o `general` implícito.
 */
export function discoverAgents(projectRoot: string, globalRoots: string[]): AgentDefinition[] {
  const key = JSON.stringify([pathKey(projectRoot), globalRoots])
  return cache.get(key, () => {
    const roots = [
      ...globalRoots.map((r) => ({ dir: resolve(expandHome(r)), scope: 'global' as const })),
      { dir: join(resolve(projectRoot), PROJECT_AGENT_DIR), scope: 'project' as const }
    ]
    const deps: string[] = []
    const byName = new Map<string, AgentDefinition>()
    for (const root of roots) {
      deps.push(root.dir)
      for (const file of listFiles(root.dir, '.md')) {
        const path = join(root.dir, file)
        deps.push(path)
        if (!isFile(path)) continue
        const def = readAgent(path, root.scope)
        if (def) byName.set(def.name, def)
      }
    }
    const value = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { value, deps }
  })
}

/** Agentes disponíveis para `task`: os definidos + o `general` implícito (se ninguém o redefiniu). */
export function availableAgents(projectRoot: string, globalRoots: string[]): AgentDefinition[] {
  const defs = discoverAgents(projectRoot, globalRoots)
  return defs.some((d) => d.name === GENERAL_AGENT) ? defs : [GENERAL_DEFINITION, ...defs]
}

export function findAgent(
  projectRoot: string,
  globalRoots: string[],
  name: string
): AgentDefinition | null {
  const n = name.trim()
  return availableAgents(projectRoot, globalRoots).find((a) => a.name === n) ?? null
}

/** Corpo do arquivo do agente (vira instruções extras do filho); vazio para o `general`. */
export function agentPrompt(def: AgentDefinition): string {
  if (!def.path) return ''
  try {
    return parseFrontmatter(readFileSync(def.path, 'utf8')).body.trim()
  } catch {
    return ''
  }
}

/**
 * Filtra as ferramentas pelo `tools` da definição (nomes do JustToCode ou do Claude Code,
 * sem diferenciar maiúsculas). `null` = todas.
 */
export function filterTools<T extends { name: string }>(tools: T[], allowed: string[] | null): T[] {
  if (!allowed) return tools
  const names = new Set<string>()
  for (const a of allowed) {
    const k = a.trim().toLowerCase()
    names.add(k)
    for (const alias of TOOL_ALIASES[k] ?? []) names.add(alias)
  }
  return tools.filter((t) => names.has(t.name.toLowerCase()))
}
