import type {
  ActiveInstructions,
  ChatSettings,
  Instruction,
  InstructionKind,
  InstructionScope,
  InstructionSource,
  InstructionTrigger,
  ReasoningLevel,
  SettingSuggestion
} from '@shared/domain'
import type { HostParams } from '@shared/api'

// Lógica pura da tela Instruções, do indicador de ativas, do `/regra` e dos ajustes do chat.
// Só importa de @shared para rodar nos testes (Vitest, ambiente node).

export const KIND_ORDER: InstructionKind[] = ['rule', 'command', 'skill', 'memory']

export const KIND_TAB_LABEL: Record<InstructionKind, string> = {
  rule: 'Regras',
  command: 'Comandos',
  skill: 'Skills',
  memory: 'Memórias'
}

export const KIND_LABEL: Record<InstructionKind, string> = {
  rule: 'regra',
  command: 'comando',
  skill: 'skill',
  memory: 'memória'
}

export const SCOPE_LABEL: Record<InstructionScope, string> = {
  global: 'global',
  project: 'projeto',
  group: 'grupo',
  chat: 'chat'
}

export const TRIGGER_LABEL: Record<InstructionTrigger, string> = {
  always: 'sempre',
  glob: 'por arquivo',
  model: 'o modelo decide',
  manual: 'manual (@nome)'
}

export type ScopeFilter = 'all' | InstructionScope

/** O que o projeto selecionado conhece (para esconder itens de outros projetos). */
export interface InstructionContextIds {
  projectId: string
  groupIds: ReadonlySet<string>
  chatIds: ReadonlySet<string>
}

/** Junta listas por id; a última ocorrência vence (mais nova). Mantém a ordem da 1ª aparição. */
export function mergeById(...lists: Instruction[][]): Instruction[] {
  const byId = new Map<string, Instruction>()
  for (const list of lists) for (const i of list) byId.set(i.id, i)
  return [...byId.values()]
}

/**
 * Itens que fazem sentido na tela: globais sempre; projeto/grupo/chat só do projeto selecionado.
 * Sem projeto (ctx null) mostra tudo.
 */
export function visibleInstructions(
  list: Instruction[],
  ctx: InstructionContextIds | null
): Instruction[] {
  if (!ctx) return list
  return list.filter((i) => {
    switch (i.scope) {
      case 'global':
        return true
      case 'project':
        return i.scopeId === ctx.projectId
      case 'group':
        return i.scopeId !== null && ctx.groupIds.has(i.scopeId)
      case 'chat':
        return i.scopeId !== null && ctx.chatIds.has(i.scopeId)
      default:
        return false
    }
  })
}

const SCOPE_RANK: Record<InstructionScope, number> = { chat: 0, group: 1, project: 2, global: 3 }

/** Filtra por tipo, escopo e texto; ordena por escopo (mais específico primeiro) e nome. */
export function filterInstructions(
  list: Instruction[],
  f: { kind: InstructionKind; scope: ScopeFilter; query?: string }
): Instruction[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list
    .filter(
      (i) =>
        i.kind === f.kind &&
        (f.scope === 'all' || i.scope === f.scope) &&
        (!q ||
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          (i.kind === 'memory' && i.body.toLowerCase().includes(q)))
    )
    .sort(
      (a, b) =>
        (f.kind === 'memory' ? b.updatedAt - a.updatedAt : 0) ||
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        a.name.localeCompare(b.name)
    )
}

/** Contagem por tipo (para os rótulos das abas). */
export function countByKind(list: Instruction[]): Record<InstructionKind, number> {
  const r: Record<InstructionKind, number> = { rule: 0, command: 0, skill: 0, memory: 0 }
  for (const i of list) r[i.kind]++
  return r
}

/** Itens criados pelo app podem ser editados/excluídos; descobertos/instalados só liga/desliga. */
export const isEditable = (i: Pick<Instruction, 'readonly' | 'source'>): boolean =>
  !i.readonly && i.source.type === 'app'

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** Rótulo curto da origem do item. */
export function sourceLabel(s: InstructionSource): string {
  switch (s.type) {
    case 'app':
      return 'criado no app'
    case 'file':
      return baseName(s.path)
    case 'plugin':
      return `plugin ${s.plugin}@${s.marketplace}`
    case 'github':
      return `GitHub ${s.url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}`
    default:
      return 'desconhecida'
  }
}

/** Título completo da origem (tooltip). */
export function sourceTitle(s: InstructionSource): string {
  switch (s.type) {
    case 'app':
      return 'Criado no JustToCode'
    case 'file':
      return s.path
    case 'plugin':
      return `${s.marketplace}/${s.plugin}: ${s.path}`
    case 'github':
      return `${s.url}@${s.ref} (${s.sha.slice(0, 7)}): ${s.path}`
    default:
      return ''
  }
}

export interface ThirdPartyOrigin {
  id: string
  /** Nome da instrução de terceiro, quando ela ainda existe na lista. */
  label: string
  count: number
}

/** Terceiros (instruções instaladas) que influenciaram memórias, com quantas memórias cada. */
export function thirdPartyOrigins(memories: Instruction[], all: Instruction[]): ThirdPartyOrigin[] {
  const byId = new Map(all.map((i) => [i.id, i]))
  const counts = new Map<string, number>()
  for (const m of memories)
    for (const id of new Set(m.origin?.thirdParty ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts.entries()]
    .map(([id, count]) => {
      const inst = byId.get(id)
      const label = inst
        ? `${inst.name}${inst.source.type === 'github' ? ` (${sourceLabel(inst.source)})` : ''}`
        : `instrução removida (${id.slice(0, 8)})`
      return { id, label, count }
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Resumo do indicador "N instruções ativas". */
export function activeSummary(a: ActiveInstructions | null): {
  count: number
  dropped: number
  overBudget: boolean
} {
  if (!a) return { count: 0, dropped: 0, overBudget: false }
  const dropped = a.items.filter((i) => i.included === 'dropped').length
  return { count: a.items.length - dropped, dropped, overBudget: a.overBudget }
}

export const activeLabel = (n: number): string =>
  n === 1 ? '1 instrução ativa' : `${n} instruções ativas`

// ---------------------------------------------------------------------------------------------
// Edição

export interface InstructionDraft {
  id?: string
  kind: InstructionKind
  scope: InstructionScope
  scopeId: string | null
  name: string
  description: string
  trigger: InstructionTrigger
  globs: string[]
  body: string
  /** Formato do arquivo exportado (md/toml). */
  format: 'md' | 'toml'
}

/** Rascunho para o diálogo de edição (a partir de um item existente). */
export function draftFrom(i: Instruction): InstructionDraft {
  return {
    id: i.id,
    kind: i.kind,
    scope: i.scope,
    scopeId: i.scopeId,
    name: i.name,
    description: i.description,
    trigger: i.trigger,
    globs: [...i.globs],
    body: i.body,
    format: i.format === 'toml' ? 'toml' : 'md'
  }
}

/** `a, b` / uma por linha → lista sem vazios nem repetidos. */
export function parseGlobs(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ]
}

/** Erro de validação do rascunho (ou null). */
export function validateDraft(d: InstructionDraft): string | null {
  if (!d.name.trim()) return 'Dê um nome.'
  if (/\s/.test(d.name.trim()) && d.kind !== 'memory')
    return 'O nome não pode ter espaços (ele vira /nome e @nome).'
  if (!d.body.trim()) return 'O conteúdo está vazio.'
  if (d.trigger === 'glob' && d.globs.length === 0) return 'Informe ao menos um padrão de arquivo.'
  if (d.scope !== 'global' && !d.scopeId) return 'Escopo sem destino.'
  return null
}

/** Parâmetros de `instructions.save` para um rascunho. */
export function saveParams(d: InstructionDraft): HostParams<'instructions.save'> {
  return {
    ...(d.id ? { id: d.id } : {}),
    kind: d.kind,
    scope: d.scope,
    scopeId: d.scope === 'global' ? null : d.scopeId,
    name: d.name.trim(),
    description: d.description.trim(),
    trigger: d.trigger,
    globs: d.trigger === 'glob' ? d.globs : [],
    body: d.body,
    format: d.kind === 'memory' ? 'md' : d.format
  }
}

// ---------------------------------------------------------------------------------------------
// `/regra`

/** `/regra texto` → `texto` (pode ser vazio); outra coisa → null. */
export function parseRuleCommand(text: string): string | null {
  const m = /^\/regra(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}

/** Nome curto para a regra a partir do texto: palavras ligadas por `-`, até 40 caracteres. */
export function ruleName(text: string, now = Date.now()): string {
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || `regra-${now.toString(36)}`
}

/** `instructions.save` de uma regra do chat. */
export function ruleSaveParams(chatId: string, ruleText: string): HostParams<'instructions.save'> {
  return {
    kind: 'rule',
    scope: 'chat',
    scopeId: chatId,
    trigger: 'always',
    name: ruleName(ruleText),
    description: '',
    body: ruleText.trim()
  }
}

export interface ChatPatch {
  settings?: Partial<ChatSettings>
  tokenBudget?: number | null
  maxIterations?: number | null
}

const SETTING_KEYS: (keyof ChatSettings)[] = [
  'reasoning',
  'subagentCombo',
  'subagentReasoning',
  'summarizerModel'
]

/** Sugestões aceitas → patch de `chats.update` (settings parcial + limites). Null se vazio. */
export function suggestionsToPatch(chosen: SettingSuggestion[]): ChatPatch | null {
  const patch: ChatPatch = {}
  const settings: Partial<ChatSettings> = {}
  for (const s of chosen) {
    if (s.key === 'tokenBudget' || s.key === 'maxIterations') {
      patch[s.key] = typeof s.value === 'number' ? s.value : null
    } else if (SETTING_KEYS.includes(s.key)) {
      const v = s.value === null ? null : String(s.value)
      if (s.key === 'reasoning' || s.key === 'subagentReasoning')
        settings[s.key] = isReasoningLevel(v) ? v : null
      else settings[s.key] = v
    }
  }
  if (Object.keys(settings).length) patch.settings = settings
  return Object.keys(patch).length ? patch : null
}

// ---------------------------------------------------------------------------------------------
// Ajustes do chat

export const REASONING_LEVELS: ReasoningLevel[] = ['low', 'medium', 'high']

export const isReasoningLevel = (v: unknown): v is ReasoningLevel =>
  v === 'low' || v === 'medium' || v === 'high'

/** Valor de Select para "padrão" (Radix não aceita string vazia). */
export const DEFAULT_OPTION = '__default'

export const toOption = (v: string | null): string => v ?? DEFAULT_OPTION
export const fromOption = (v: string): string | null => (v === DEFAULT_OPTION ? null : v)

/** Campo de limite de iterações: vazio → null (sem limite); inteiro > 0; senão undefined. */
export function parseIterationsInput(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return n > 0 ? n : undefined
}

/** Chip do header: "reasoning: low · não confirmado"; null quando nada foi pedido. */
export function reasoningChip(
  r: { requested: ReasoningLevel | null; confirmed: boolean } | null
): { text: string; confirmed: boolean } | null {
  if (!r || r.requested === null) return null
  return {
    text: `reasoning: ${r.requested} · ${r.confirmed ? 'confirmado' : 'não confirmado'}`,
    confirmed: r.confirmed
  }
}

/** Destaque do card de memória (15 s a partir do evento). */
export const MEMORY_HIGHLIGHT_MS = 15_000
export const memoryHighlighted = (at: number, now: number): boolean =>
  now - at < MEMORY_HIGHLIGHT_MS
