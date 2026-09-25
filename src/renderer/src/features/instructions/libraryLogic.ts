import type {
  InstallPreview,
  InstallPreviewItem,
  Instruction,
  InstructionKind,
  InstructionScope,
  InstructionTrigger
} from '@shared/domain'
import type { HostParams } from '@shared/api'
import { SCOPE_LABEL, type InstructionDraft } from './logic'

// Lógica pura da Task 4.D: novo item (escopo + alvo), instalação do GitHub (seleção, suspeitos),
// verificação de atualização (diff) e agrupamento de plugins. Só importa de @shared/./logic.

// ---------------------------------------------------------------------------------------------
// Novo item / escopo + alvo

export const DEFAULT_TRIGGER: Record<InstructionKind, InstructionTrigger> = {
  rule: 'always',
  command: 'manual',
  skill: 'model',
  memory: 'always'
}

/** O que a tela conhece do projeto atual para escolher o alvo de um escopo. */
export interface ScopeTargetContext {
  project: { id: string; name: string } | null
  groups: { id: string; name: string }[]
  chats: { id: string; title: string }[]
  /** Chat aberto (preferido como alvo do escopo chat). */
  chatId: string | null
}

export interface ScopeTarget {
  id: string
  label: string
}

export interface ScopeOption {
  scope: InstructionScope
  label: string
  /** Vazio em global. */
  targets: ScopeTarget[]
}

/** Escopos disponíveis com os alvos do projeto atual (escopos sem alvo ficam de fora). */
export function scopeOptions(ctx: ScopeTargetContext): ScopeOption[] {
  const out: ScopeOption[] = [{ scope: 'global', label: SCOPE_LABEL.global, targets: [] }]
  if (ctx.project) {
    out.push({
      scope: 'project',
      label: SCOPE_LABEL.project,
      targets: [{ id: ctx.project.id, label: ctx.project.name }]
    })
    if (ctx.groups.length)
      out.push({
        scope: 'group',
        label: SCOPE_LABEL.group,
        targets: ctx.groups.map((g) => ({ id: g.id, label: g.name }))
      })
    if (ctx.chats.length)
      out.push({
        scope: 'chat',
        label: SCOPE_LABEL.chat,
        targets: ctx.chats.map((c) => ({ id: c.id, label: c.title || 'Sem título' }))
      })
  }
  return out
}

/**
 * Alvo para um escopo: mantém o atual se ele ainda é válido; senão o chat aberto (escopo chat)
 * ou o primeiro da lista. Global → null.
 */
export function defaultTargetId(
  scope: InstructionScope,
  ctx: ScopeTargetContext,
  current: string | null = null
): string | null {
  if (scope === 'global') return null
  const targets = scopeOptions(ctx).find((o) => o.scope === scope)?.targets ?? []
  if (current && targets.some((t) => t.id === current)) return current
  if (scope === 'chat' && ctx.chatId && targets.some((t) => t.id === ctx.chatId)) return ctx.chatId
  return targets[0]?.id ?? null
}

/** Rascunho vazio para "Nova" (escopo projeto quando há projeto; senão global). */
export function newDraft(kind: InstructionKind, ctx: ScopeTargetContext): InstructionDraft {
  const scope: InstructionScope = ctx.project ? 'project' : 'global'
  return {
    kind,
    scope,
    scopeId: defaultTargetId(scope, ctx),
    name: '',
    description: '',
    trigger: DEFAULT_TRIGGER[kind],
    globs: [],
    body: '',
    format: 'md'
  }
}

/** Troca o tipo do rascunho; o gatilho acompanha se ainda era o padrão do tipo anterior. */
export function changeDraftKind(d: InstructionDraft, kind: InstructionKind): InstructionDraft {
  const trigger =
    kind === 'memory' || d.trigger === DEFAULT_TRIGGER[d.kind] ? DEFAULT_TRIGGER[kind] : d.trigger
  return { ...d, kind, trigger, format: kind === 'memory' ? 'md' : d.format }
}

/** Troca o escopo do rascunho escolhendo um alvo válido. */
export function changeDraftScope(
  d: InstructionDraft,
  scope: InstructionScope,
  ctx: ScopeTargetContext
): InstructionDraft {
  return { ...d, scope, scopeId: defaultTargetId(scope, ctx, d.scope === scope ? d.scopeId : null) }
}

/** Mensagem do erro de `instructions.export`. */
export function exportErrorMessage(code: unknown, message: string): string {
  if (code === 'EXISTS') return `O arquivo já existe no repo; nada foi sobrescrito. ${message}`
  if (code === 'READONLY') return 'Só itens criados no app podem ser exportados.'
  if (code === 'NOT_FOUND') return `Não encontrado: ${message}`
  return `Não foi possível exportar: ${message}`
}

// ---------------------------------------------------------------------------------------------
// Instalar do GitHub

export type Suspicious = InstallPreviewItem['suspicious'][number]

/** `"<arquivo de apoio>: <nome>"` → arquivo + nome; nomes de codepoint não têm `: `. */
export function splitSuspiciousName(name: string): { file: string | null; name: string } {
  const i = name.indexOf(': ')
  return i > 0 ? { file: name.slice(0, i), name: name.slice(i + 2) } : { file: null, name }
}

/** "linha 3, coluna 5: U+200B ZERO WIDTH SPACE (em apoio.md)". */
export function describeSuspicious(s: Suspicious): string {
  const { file, name } = splitSuspiciousName(s.name)
  return `linha ${s.line}, coluna ${s.col}: ${s.codepoint} ${name}${file ? ` (em ${file})` : ''}`
}

export const isBlocked = (i: Pick<InstallPreviewItem, 'suspicious'>): boolean =>
  i.suspicious.length > 0

/** Seleção inicial: todos os itens sem suspeitos. */
export const initialSelection = (p: InstallPreview): Set<string> =>
  new Set(p.items.filter((i) => !isBlocked(i)).map((i) => i.path))

/** Liga/desliga um item na seleção; itens bloqueados nunca entram. */
export function toggleSelection(
  sel: ReadonlySet<string>,
  item: InstallPreviewItem,
  on: boolean
): Set<string> {
  const next = new Set(sel)
  if (on && !isBlocked(item)) next.add(item.path)
  else next.delete(item.path)
  return next
}

/** Seleciona/limpa todos os liberados. */
export function selectAll(p: InstallPreview, on: boolean): Set<string> {
  return on ? initialSelection(p) : new Set()
}

/** Parâmetros de `library.installGithub` (null se nada instalável ou alvo faltando). */
export function installParams(
  p: InstallPreview,
  sel: ReadonlySet<string>,
  scope: InstructionScope,
  scopeId: string | null
): HostParams<'library.installGithub'> | null {
  const paths = p.items.filter((i) => sel.has(i.path) && !isBlocked(i)).map((i) => i.path)
  if (!paths.length) return null
  if (scope !== 'global' && !scopeId) return null
  return {
    url: p.url,
    ref: p.ref,
    sha: p.sha,
    paths,
    scope,
    scopeId: scope === 'global' ? null : scopeId
  }
}

export interface ContentSegment {
  text: string
  /** Codepoint (U+XXXX) quando o segmento é um caractere suspeito. */
  suspicious?: string
  name?: string
}

export interface ContentLine {
  line: number
  segments: ContentSegment[]
  flagged: boolean
}

/**
 * Quebra o conteúdo em linhas com os caracteres suspeitos isolados (linha/coluna em codepoints,
 * começando em 1, como o scanner). Suspeitos de arquivos de apoio são ignorados aqui.
 */
export function markContent(content: string, suspicious: Suspicious[]): ContentLine[] {
  const byLine = new Map<number, Map<number, Suspicious>>()
  for (const s of suspicious) {
    if (splitSuspiciousName(s.name).file) continue
    const m = byLine.get(s.line) ?? new Map<number, Suspicious>()
    m.set(s.col, s)
    byLine.set(s.line, m)
  }
  return content.split('\n').map((raw, idx) => {
    const line = idx + 1
    const marks = byLine.get(line)
    if (!marks) return { line, segments: [{ text: raw }], flagged: false }
    const segments: ContentSegment[] = []
    let buf = ''
    let col = 0
    for (const ch of raw) {
      col++
      const s = marks.get(col)
      if (s) {
        if (buf) segments.push({ text: buf })
        buf = ''
        segments.push({
          text: ch,
          suspicious: s.codepoint,
          name: splitSuspiciousName(s.name).name
        })
      } else buf += ch
    }
    if (buf) segments.push({ text: buf })
    return { line, segments, flagged: true }
  })
}

export const INSTALL_ERRORS: Record<string, string> = {
  SUSPICIOUS_CONTENT: 'Instalação recusada: há caracteres invisíveis/bidi no conteúdo.',
  TOO_MANY_FILES: 'O repositório tem arquivos demais para instalar.',
  NOT_FOUND: 'Não encontrado no repositório.',
  UNSUPPORTED: 'Só arquivos .md e .toml podem ser instalados.'
}

// ---------------------------------------------------------------------------------------------
// Verificar atualização

/** Tira o frontmatter `---` de um `.md` (o corpo instalado não o tem). */
export function stripFrontmatter(content: string): string {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? text.slice(m[0].length) : content
}

/** Item do preview correspondente a um instalado (mesmo `path`; senão o único). */
export function previewItemFor(
  i: Pick<Instruction, 'source'>,
  p: InstallPreview
): InstallPreviewItem | null {
  if (i.source.type === 'github') {
    const path = i.source.path
    const found = p.items.find((x) => x.path === path)
    if (found) return found
  }
  return p.items.length === 1 ? p.items[0] : null
}

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

const MAX_DIFF_CELLS = 4_000_000

/** Diff de linhas (LCS). Textos grandes demais viram "tudo removido + tudo adicionado". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text }))
    ]
  }
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: a[i++] })
    else out.push({ type: 'add', text: b[j++] })
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

/** Diff do corpo instalado contra o conteúdo novo (sem frontmatter nos `.md`). */
export function updateDiff(i: Pick<Instruction, 'body'>, item: InstallPreviewItem): DiffLine[] {
  const next = item.format === 'md' ? stripFrontmatter(item.content) : item.content
  return lineDiff(i.body.trimEnd(), next.trimEnd())
}

/** "main · abc1234" da versão instalada (vazio se não veio do GitHub). */
export const sourceShort = (i: Pick<Instruction, 'source'>): string =>
  i.source.type === 'github' ? `${i.source.ref} · ${i.source.sha.slice(0, 7)}` : ''

export const diffStats = (d: DiffLine[]): { added: number; removed: number } => ({
  added: d.filter((l) => l.type === 'add').length,
  removed: d.filter((l) => l.type === 'del').length
})

/** Parâmetros para reinstalar um item do GitHub no sha novo (mesmo escopo). */
export function updateParams(
  i: Pick<Instruction, 'source' | 'scope' | 'scopeId'>,
  p: InstallPreview,
  item: InstallPreviewItem
): HostParams<'library.installGithub'> | null {
  if (i.source.type !== 'github' || isBlocked(item)) return null
  return {
    url: i.source.url,
    ref: i.source.ref,
    sha: p.sha,
    paths: [item.path],
    scope: i.scope,
    scopeId: i.scope === 'global' ? null : i.scopeId
  }
}

// ---------------------------------------------------------------------------------------------
// Plugins agrupados

export interface PluginGroup {
  key: string
  plugin: string
  marketplace: string
  items: Instruction[]
  enabled: number
}

/** Separa itens de plugin (agrupados por plugin@marketplace) do resto, mantendo a ordem. */
export function groupByPlugin(list: Instruction[]): { groups: PluginGroup[]; rest: Instruction[] } {
  const groups = new Map<string, PluginGroup>()
  const rest: Instruction[] = []
  for (const i of list) {
    if (i.source.type !== 'plugin') {
      rest.push(i)
      continue
    }
    const { plugin, marketplace } = i.source
    const key = `${plugin}@${marketplace}`
    const g = groups.get(key) ?? { key, plugin, marketplace, items: [], enabled: 0 }
    g.items.push(i)
    if (i.enabled) g.enabled++
    groups.set(key, g)
  }
  return {
    groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
    rest
  }
}

/** Estado do toggle do grupo: ligado se todos ligados; misto se parte. */
export function groupToggleState(g: PluginGroup): 'on' | 'off' | 'mixed' {
  if (g.enabled === 0) return 'off'
  return g.enabled === g.items.length ? 'on' : 'mixed'
}

/** Itens que precisam mudar para o toggle em lote. */
export const batchToggleTargets = (g: PluginGroup, on: boolean): Instruction[] =>
  g.items.filter((i) => i.enabled !== on)
