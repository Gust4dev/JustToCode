import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type {
  InstallPreview,
  InstallPreviewItem,
  Instruction,
  InstructionKind,
  InstructionScope,
  InstructionTrigger
} from '@shared/domain'
import { RpcError } from '@shared/rpc'
import { fmString, parseFrontmatter } from '../ecosystem/frontmatter'
import type { InstructionRepo } from '../repo/instructions'
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  parseGithubUrl,
  tooLarge,
  type GithubClient,
  type GithubTarget,
  type TreeEntry
} from './github'
import { scanText } from './scanner'

/** Item detectado na árvore: arquivo principal + arquivos que vão junto (pasta da skill). */
export interface DetectedItem {
  path: string
  kind: InstructionKind
  format: 'md' | 'toml'
  files: string[]
}

const isSkillFile = (p: string): boolean => posix.basename(p).toLowerCase() === 'skill.md'
const formatOf = (p: string): 'md' | 'toml' | null => {
  const l = p.toLowerCase()
  return l.endsWith('.md') ? 'md' : l.endsWith('.toml') ? 'toml' : null
}

/** `rules|commands|prompts` no caminho → rule/command (vale o segmento mais próximo do arquivo). */
function kindFromPath(p: string): InstructionKind | null {
  const dirs = p.split('/').slice(0, -1).reverse()
  for (const d of dirs) {
    const l = d.toLowerCase()
    if (l === 'rules') return 'rule'
    if (l === 'commands' || l === 'prompts') return 'command'
  }
  return null
}

const within = (p: string, prefix: string): boolean =>
  !prefix || p === prefix || p.startsWith(`${prefix}/`)

/**
 * Detecta itens instaláveis no escopo do alvo: pastas com `SKILL.md` (skill com a pasta inteira) e
 * `.md`/`.toml` sob `rules|commands|prompts` (layout de plugin `.claude-plugin` incluso: as
 * `skills/*` e `commands/*` dele caem nas mesmas regras). `blob` instala só aquele arquivo.
 */
export function detectItems(tree: TreeEntry[], target: GithubTarget): DetectedItem[] {
  const blobs = tree.filter((e) => e.type === 'blob').map((e) => e.path)
  const skillDirs = blobs.filter(isSkillFile).map((p) => posix.dirname(p))
  const inSkill = (p: string): string | undefined =>
    skillDirs.find((d) => d === '.' || within(p, d))
  const skillItem = (skillFile: string): DetectedItem => {
    const dir = posix.dirname(skillFile)
    return {
      path: skillFile,
      kind: 'skill',
      format: 'md',
      files: blobs.filter((p) => dir === '.' || within(p, dir))
    }
  }

  if (target.kind === 'blob') {
    if (!blobs.includes(target.path)) {
      throw new RpcError(`Arquivo não encontrado no repositório: ${target.path}`, 'NOT_FOUND')
    }
    if (isSkillFile(target.path)) return [skillItem(target.path)]
    const format = formatOf(target.path)
    if (!format) throw new RpcError('Só arquivos .md e .toml podem ser instalados', 'UNSUPPORTED')
    return [
      { path: target.path, kind: kindFromPath(target.path) ?? 'rule', format, files: [target.path] }
    ]
  }

  const scoped = blobs.filter((p) => within(p, target.path))
  const items: DetectedItem[] = []
  for (const p of scoped) {
    if (isSkillFile(p)) {
      items.push(skillItem(p))
      continue
    }
    if (inSkill(p)) continue
    const format = formatOf(p)
    const kind = kindFromPath(p)
    if (!format || !kind || /^readme\./i.test(posix.basename(p))) continue
    items.push({ path: p, kind, format, files: [p] })
  }
  return items.sort((a, b) => a.path.localeCompare(b.path))
}

interface ParsedItem {
  name: string
  description: string
  kind: InstructionKind
  trigger: InstructionTrigger
  globs: string[]
  body: string
}

const KINDS: InstructionKind[] = ['rule', 'command', 'skill']
const TRIGGERS: InstructionTrigger[] = ['always', 'glob', 'model', 'manual']
const DEFAULT_TRIGGER: Record<InstructionKind, InstructionTrigger> = {
  rule: 'always',
  command: 'manual',
  skill: 'model',
  memory: 'manual'
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

/** Nome/descrição/tipo (e gatilho/globs/corpo) do arquivo principal. A 4.A formaliza os campos. */
export function parseItem(item: DetectedItem, text: string): ParsedItem {
  let data: Record<string, unknown> = {}
  let body = text
  if (item.format === 'toml') {
    try {
      data = parseToml(text) as Record<string, unknown>
    } catch (e) {
      throw new RpcError(`TOML inválido em ${item.path}: ${(e as Error).message}`, 'INVALID_FILE')
    }
    body = str(data.prompt) || str(data.body)
  } else {
    const fm = parseFrontmatter(text)
    data = fm.data
    body = fm.body
  }
  const declared = (item.kind === 'skill' ? '' : str(data.kind)) as InstructionKind
  const kind = KINDS.includes(declared) ? declared : item.kind
  const trig = str(data.trigger) as InstructionTrigger
  const fallbackName =
    kind === 'skill'
      ? posix.basename(posix.dirname(item.path))
      : posix.basename(item.path).replace(/\.(md|toml)$/i, '')
  return {
    name: (item.format === 'md' ? fmString(data, 'name') : str(data.name)) || fallbackName,
    description: item.format === 'md' ? fmString(data, 'description') : str(data.description),
    kind,
    trigger: TRIGGERS.includes(trig) ? trig : DEFAULT_TRIGGER[kind],
    globs: list(data.globs),
    body
  }
}

const hasNul = (b: Buffer): boolean => b.includes(0)

export interface LibraryDeps {
  github: GithubClient
  instructions: InstructionRepo
  /** Raiz das instalações (`userData/library`). */
  libraryRoot: string
}

export interface InstallParams {
  url: string
  ref: string
  sha: string
  paths: string[]
  scope: InstructionScope
  scopeId: string | null
}

export interface Library {
  preview(url: string): Promise<InstallPreview>
  install(p: InstallParams): Promise<Instruction[]>
  checkUpdate(id: string): Promise<{ hasUpdate: boolean; preview: InstallPreview | null }>
  /** Pasta onde os arquivos de um item instalado ficam (ex.: arquivos de apoio de uma skill). */
  installedDir(i: Instruction): string | null
}

const SHA = /^[0-9a-f]{7,64}$/i

export function createLibrary(deps: LibraryDeps): Library {
  const { github, instructions } = deps
  const root = resolve(deps.libraryRoot)
  const repoDir = (t: GithubTarget, sha: string): string => join(root, `${t.owner}__${t.repo}`, sha)

  const sizeOk = (tree: TreeEntry[], paths: string[]): void => {
    if (paths.length > MAX_FILES) {
      throw new RpcError(`Mais de ${MAX_FILES} arquivos para baixar`, 'TOO_MANY_FILES')
    }
    const sizes = new Map(tree.map((e) => [e.path, e.size ?? 0]))
    for (const p of paths) if ((sizes.get(p) ?? 0) > MAX_FILE_BYTES) throw tooLarge(p)
  }

  const buildPreview = async (
    url: string,
    t: GithubTarget,
    ref: string,
    sha: string,
    only?: string
  ): Promise<InstallPreview> => {
    const tree = await github.listTree(t.owner, t.repo, sha)
    const detected = detectItems(tree, t).filter((d) => !only || d.path === only)
    sizeOk(tree, [...new Set(detected.flatMap((d) => d.files))])
    const items: InstallPreviewItem[] = []
    for (const d of detected) {
      const content = (await github.download(t.owner, t.repo, sha, d.path)).toString('utf8')
      const parsed = parseItem(d, content)
      const suspicious = scanText(content)
      // Arquivos de apoio (pasta da skill): achados entram com o caminho relativo no nome.
      const dir = posix.dirname(d.path)
      for (const f of d.files) {
        if (f === d.path) continue
        const buf = await github.download(t.owner, t.repo, sha, f)
        if (hasNul(buf)) continue
        const rel = dir === '.' ? f : posix.relative(dir, f)
        for (const s of scanText(buf.toString('utf8'))) {
          suspicious.push({ ...s, name: `${rel}: ${s.name}` })
        }
      }
      items.push({
        path: d.path,
        kind: parsed.kind,
        name: parsed.name,
        format: d.format,
        content,
        suspicious
      })
    }
    return { url, ref, sha, items }
  }

  const sameSource = (i: Instruction, t: GithubTarget, path: string): boolean =>
    i.source.type === 'github' && i.source.path === path && sameRepo(i, t)

  const sameRepo = (i: Instruction, t: GithubTarget): boolean => {
    if (i.source.type !== 'github') return false
    try {
      const o = parseGithubUrl(i.source.url)
      return (
        o.owner.toLowerCase() === t.owner.toLowerCase() &&
        o.repo.toLowerCase() === t.repo.toLowerCase()
      )
    } catch {
      return false
    }
  }

  return {
    async preview(url) {
      const t = parseGithubUrl(url)
      const ref = t.ref ?? (await github.defaultBranch(t.owner, t.repo))
      const sha = await github.resolveRef(t.owner, t.repo, ref)
      return buildPreview(url, t, ref, sha)
    },

    async install(p) {
      const t = parseGithubUrl(p.url)
      if (!SHA.test(String(p.sha ?? ''))) throw new RpcError('sha inválido', 'INVALID_PARAMS')
      if (!Array.isArray(p.paths) || !p.paths.length) {
        throw new RpcError('Nenhum item selecionado', 'INVALID_PARAMS')
      }
      if (p.scope !== 'global' && !p.scopeId) {
        throw new RpcError('Escopo sem alvo', 'INVALID_PARAMS')
      }
      const scopeId = p.scope === 'global' ? null : p.scopeId
      const ref = String(p.ref || p.sha)
      const tree = await github.listTree(t.owner, t.repo, p.sha)
      const detected = detectItems(tree, t)
      const chosen = p.paths.map((path) => {
        const d = detected.find((x) => x.path === path)
        if (!d) throw new RpcError(`Item não encontrado: ${path}`, 'NOT_FOUND')
        return d
      })
      const allFiles = [...new Set(chosen.flatMap((d) => d.files))]
      sizeOk(tree, allFiles)

      // Baixa e verifica tudo antes de gravar qualquer coisa.
      const base = repoDir(t, p.sha)
      const files = new Map<string, Buffer>()
      const problems: string[] = []
      for (const f of allFiles) {
        const target = resolve(base, ...f.split('/'))
        if (!target.startsWith(base + sep)) {
          throw new RpcError(`Caminho inválido: ${f}`, 'INVALID_PATH')
        }
        const buf = await github.download(t.owner, t.repo, p.sha, f)
        if (!hasNul(buf)) {
          for (const s of scanText(buf.toString('utf8'))) {
            problems.push(`${f}:${s.line}:${s.col} ${s.codepoint} ${s.name}`)
          }
        }
        files.set(f, buf)
      }
      if (problems.length) {
        throw new RpcError(
          `Conteúdo suspeito (caracteres invisíveis/bidi):\n${problems.slice(0, 20).join('\n')}`,
          'SUSPICIOUS_CONTENT'
        )
      }
      const parsed = chosen.map((d) => {
        const text = (files.get(d.path) as Buffer).toString('utf8')
        return { d, parsed: parseItem(d, text) }
      })

      for (const [f, buf] of files) {
        const target = resolve(base, ...f.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buf)
      }

      const existing = instructions.list({ scope: p.scope, scopeId })
      const oldShas = new Set<string>()
      const result = parsed.map(({ d, parsed: x }) => {
        const fields = {
          kind: x.kind,
          name: x.name,
          description: x.description,
          trigger: x.trigger,
          globs: x.globs,
          body: x.body,
          format: d.format,
          source: { type: 'github' as const, url: p.url, ref, path: d.path, sha: p.sha }
        }
        const prev = existing.find((i) => sameSource(i, t, d.path))
        // Atualização mantém o liga/desliga do item.
        if (prev) {
          if (prev.source.type === 'github' && prev.source.sha !== p.sha) {
            oldShas.add(prev.source.sha)
          }
          return instructions.update(prev.id, fields)
        }
        return instructions.create({ ...fields, scope: p.scope, scopeId, enabled: true })
      })
      // Pasta do sha anterior sai quando nenhum item instalado aponta mais para ela.
      if (oldShas.size) {
        const inUse = new Set(
          instructions
            .list()
            .filter((i) => i.source.type === 'github' && sameRepo(i, t))
            .map((i) => (i.source.type === 'github' ? i.source.sha : ''))
        )
        for (const old of oldShas) {
          if (inUse.has(old) || !SHA.test(old)) continue
          rmSync(repoDir(t, old), { recursive: true, force: true })
        }
      }
      return result
    },

    async checkUpdate(id) {
      const i = instructions.get(id)
      if (!i) throw new RpcError('Instrução não encontrada', 'NOT_FOUND')
      if (i.source.type !== 'github') {
        throw new RpcError('Instrução não veio do GitHub', 'INVALID_PARAMS')
      }
      const { url, ref, sha: oldSha, path } = i.source
      const t = parseGithubUrl(url)
      const sha = await github.resolveRef(t.owner, t.repo, ref)
      if (sha === oldSha) return { hasUpdate: false, preview: null }
      return { hasUpdate: true, preview: await buildPreview(url, t, ref, sha, path) }
    },

    installedDir(i) {
      if (i.source.type !== 'github') return null
      const t = parseGithubUrl(i.source.url)
      const file = resolve(repoDir(t, i.source.sha), ...i.source.path.split('/'))
      return dirname(file)
    }
  }
}
