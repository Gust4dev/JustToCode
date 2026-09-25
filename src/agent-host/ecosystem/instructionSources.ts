import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import type { AppConfig, Instruction, InstructionSource } from '@shared/domain'
import { loadInstructionSections, type InstructionSection } from './instructions'
import { discoverSkills } from './skills'
import { listFileCommands } from './commands'
import { formatOf, parseInstructionText, type InstructionFile } from './frontmatter'
import { discoverRuleFiles } from './rules'
import { listPlugins, type PluginDir } from './plugins'
import { pathKey } from './paths'

/** Raízes do ecossistema lidas da config (arquivos do usuário e plugins). */
export type EcosystemConfig = Pick<
  AppConfig,
  'instructionFiles' | 'skillRoots' | 'commandRoots' | 'pluginRoots'
> &
  Partial<Pick<AppConfig, 'ruleRoots'>>

/** Id estável de um item descoberto: `sha1(tipo da fonte + caminho normalizado)`. */
export function stableInstructionId(sourceType: 'file' | 'plugin', path: string): string {
  return createHash('sha1')
    .update(sourceType + pathKey(path))
    .digest('hex')
}

function pluginOf(path: string, plugins: PluginDir[]): PluginDir | null {
  const key = pathKey(path)
  for (const p of plugins) {
    const rel = relative(pathKey(p.dir), key)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return p
  }
  return null
}

function sourceFor(path: string, plugins: PluginDir[]): InstructionSource {
  const p = pluginOf(path, plugins)
  return p
    ? { type: 'plugin', marketplace: p.marketplace, plugin: p.plugin, path }
    : { type: 'file', path }
}

function base(
  source: InstructionSource,
  path: string
): Pick<
  Instruction,
  | 'id'
  | 'globs'
  | 'format'
  | 'source'
  | 'enabled'
  | 'readonly'
  | 'origin'
  | 'createdAt'
  | 'updatedAt'
> {
  return {
    id: stableInstructionId(source.type === 'plugin' ? 'plugin' : 'file', path),
    globs: [],
    format: 'md',
    source,
    enabled: true,
    readonly: true,
    origin: null,
    createdAt: 0,
    updatedAt: 0
  }
}

/** Arquivo de instrução (`.md` com frontmatter ou `.toml`); ilegível → vazio. */
function readInstructionFile(path: string): InstructionFile {
  const format = formatOf(path)
  try {
    return parseInstructionText(readFileSync(path, 'utf8'), format)
  } catch {
    return { format, data: {}, body: '', meta: {} }
  }
}

/** Gatilho/globs/formato do arquivo; sem `trigger` no arquivo, vale o padrão do tipo. */
function fileFields(
  f: InstructionFile,
  defaultTrigger: Instruction['trigger']
): Pick<Instruction, 'trigger' | 'globs' | 'format' | 'body'> {
  return {
    trigger: f.meta.trigger ?? defaultTrigger,
    globs: f.meta.globs ?? [],
    format: f.format,
    body: f.body.trim()
  }
}

/** Memo de uma entrada por chave: recomputa só quando alguma das listas de origem muda (cache por mtime). */
class RefMemo<T> {
  private entries = new Map<string, { refs: unknown[]; value: T }>()
  get(key: string, refs: unknown[], compute: () => T): T {
    const hit = this.entries.get(key)
    if (hit && hit.refs.length === refs.length && hit.refs.every((r, i) => r === refs[i])) {
      return hit.value
    }
    const value = compute()
    this.entries.set(key, { refs, value })
    return value
  }
}

const memo = new RefMemo<Instruction[]>()

function rulesFrom(sections: InstructionSection[], projectId: string | null): Instruction[] {
  return sections.map((s) => ({
    ...base({ type: 'file', path: s.path }, s.path),
    kind: 'rule',
    scope: s.scope === 'project' && projectId ? 'project' : 'global',
    scopeId: s.scope === 'project' && projectId ? projectId : null,
    // O caminho é o nome: dois CLAUDE.md (global e projeto) não se anulam na precedência.
    name: s.path,
    description: s.scope === 'project' ? 'Instruções do projeto' : 'Instruções globais',
    trigger: 'always',
    body: s.text
  }))
}

/**
 * O que já existe no disco como `Instruction` (somente leitura, liga/desliga por toggle):
 * AGENTS.md/CLAUDE.md → `rule/always`; `rules/**` → `rule` (`always`, ou `glob` se tiver globs);
 * skills → `skill/model`; commands (`.md`/`.toml`) → `command/manual`. `trigger`/`globs` do
 * frontmatter (ou do `.toml`) substituem o padrão do tipo.
 * Ordem: instruções (ordem da config, depois projeto), regras em arquivo, skills e comandos.
 * `toggles` (id → enabled) vem de `instruction_toggles`; sem entrada = ligado.
 */
export function discoverInstructions(
  projectRoot: string,
  projectId: string | null,
  cfg: EcosystemConfig,
  toggles: Map<string, boolean> = new Map()
): Instruction[] {
  const pluginRoots = cfg.pluginRoots ?? []
  const sections = loadInstructionSections(projectRoot, cfg.instructionFiles ?? [])
  const skills = discoverSkills(projectRoot, cfg.skillRoots ?? [], pluginRoots)
  const commands = listFileCommands(projectRoot, cfg.commandRoots ?? [], pluginRoots)
  const rules = discoverRuleFiles(projectRoot, cfg.ruleRoots ?? [])
  const key = JSON.stringify([pathKey(projectRoot), projectId, pluginRoots])
  const all = memo.get(key, [sections, skills, commands, rules], () => {
    const plugins = pluginRoots.length ? listPlugins(pluginRoots, []) : []
    const scopeOf = (s: 'global' | 'project'): Pick<Instruction, 'scope' | 'scopeId'> =>
      s === 'project' && projectId
        ? { scope: 'project', scopeId: projectId }
        : { scope: 'global', scopeId: null }
    const out: Instruction[] = rulesFrom(sections, projectId)
    for (const r of rules) {
      const f = readInstructionFile(r.path)
      // Sem `trigger`: com globs → `glob`, senão `always`.
      const fields = fileFields(f, f.meta.globs ? 'glob' : 'always')
      out.push({
        ...base(sourceFor(r.path, plugins), r.path),
        ...scopeOf(r.scope),
        kind: 'rule',
        name: f.meta.name ?? f.meta.command ?? r.rel,
        description: f.meta.description ?? '',
        ...fields
      })
    }
    for (const s of skills) {
      const f = readInstructionFile(s.path)
      out.push({
        ...base(sourceFor(s.path, plugins), s.path),
        ...scopeOf(s.scope),
        kind: 'skill',
        name: s.name,
        description: s.description,
        ...fileFields(f, 'model')
      })
    }
    for (const c of commands) {
      out.push({
        ...base(sourceFor(c.path, plugins), c.path),
        ...scopeOf(c.scope),
        kind: 'command',
        name: c.name,
        description: c.description,
        ...fileFields(readInstructionFile(c.path), 'manual')
      })
    }
    return out
  })
  if (!toggles.size) return all
  return all.map((i) => {
    const t = toggles.get(i.id)
    return t === undefined || t === i.enabled ? i : { ...i, enabled: t }
  })
}
