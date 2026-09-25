import type {
  ActiveInstructionItem,
  ActiveInstructions,
  AppConfig,
  Instruction,
  InstructionScope
} from '@shared/domain'
import { estimateText } from '../context/tokenizer'
import type { InstructionRepo } from '../repo/instructions'
import type { TouchedPathRepo } from '../repo/touchedPaths'
import { discoverInstructions } from './instructionSources'
import { sectionText } from './instructions'
import { matchesGlob, normalizeSlashes } from './glob'

export const SCOPE_RANK: Record<InstructionScope, number> = {
  global: 0,
  project: 1,
  group: 2,
  chat: 3
}

export interface ResolveOptions {
  chatId: string | null
  /** Caminhos relativos ao projeto que o chat leu/editou (gatilho `glob`). */
  touchedPaths: string[]
  /** Nomes usados como `@nome`/`/nome` na mensagem (gatilho `manual`). */
  manualNames: string[]
  /** Teto (tokens) do conteúdo `always`. */
  budget: number
}

export interface ResolvedInstructions {
  /** Conteúdo no prompt: `always` dentro do orçamento + `glob` que casaram (ordem global → chat). */
  always: Instruction[]
  /** Só nome + descrição no prompt (gatilho `model`); ordenado por nome. */
  listed: Instruction[]
  /** `manual` citados na mensagem. */
  manual: Instruction[]
  active: ActiveInstructions
}

const tokenMemo = new Map<string, number>()
/** Tokens estimados de um texto (memo por texto; o tokenizer é caro para textos grandes). */
function tokens(text: string): number {
  let n = tokenMemo.get(text)
  if (n === undefined) {
    n = estimateText(text)
    if (tokenMemo.size > 1000) tokenMemo.clear()
    tokenMemo.set(text, n)
  }
  return n
}

export const listedLine = (i: Pick<Instruction, 'name' | 'description'>): string =>
  `- ${i.name}: ${i.description.replace(/\s+/g, ' ').trim()}`

/**
 * Nomes `@nome`/`/nome` presentes no texto (início ou após espaço; termina em espaço,
 * pontuação ou fim). Só devolve os que existem em `known`.
 */
export function mentionedNames(text: string, known: Iterable<string>): string[] {
  const out: string[] = []
  for (const name of known) {
    if (!name) continue
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|\\s)[@/]${esc}(?=$|[\\s.,;:!?)])`)
    if (re.test(text) && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Resolução pura: filtra `enabled`, aplica precedência chat > grupo > projeto > global por
 * `kind + name` (empate: o candidato posterior vence), aplica os gatilhos e o orçamento `always`
 * (corta a partir do primeiro que não couber, dos de menor precedência para cima: marca `dropped`).
 * Memórias (`kind: memory`) não entram aqui: o índice delas é uma seção própria do prompt.
 */
export function resolveInstructions(
  candidates: Instruction[],
  o: ResolveOptions
): ResolvedInstructions {
  const winners = new Map<string, { inst: Instruction; order: number }>()
  candidates.forEach((inst, order) => {
    if (!inst.enabled || inst.kind === 'memory') return
    const key = `${inst.kind}\u0000${inst.name}`
    const cur = winners.get(key)
    if (!cur || SCOPE_RANK[inst.scope] >= SCOPE_RANK[cur.inst.scope]) {
      winners.set(key, { inst, order })
    }
  })
  // Ordem estável do prompt: escopo crescente, depois a ordem dos candidatos.
  const ordered = [...winners.values()]
    .sort((a, b) => SCOPE_RANK[a.inst.scope] - SCOPE_RANK[b.inst.scope] || a.order - b.order)
    .map((w) => w.inst)

  const touched = o.touchedPaths.map(normalizeSlashes)
  const manualSet = new Set(o.manualNames)
  const items = new Map<string, ActiveInstructionItem>()
  const item = (
    i: Instruction,
    reason: string,
    included: ActiveInstructionItem['included'],
    t: number
  ): void => {
    items.set(i.id, {
      id: i.id,
      name: i.name,
      kind: i.kind,
      scope: i.scope,
      trigger: i.trigger,
      reason,
      tokens: t,
      included
    })
  }

  // Orçamento: do mais precedente ao menos; o primeiro que não cabe corta ele e os seguintes.
  const always = ordered.filter((i) => i.trigger === 'always')
  const byPrecedence = [...always].reverse()
  const keep = new Set<string>()
  let alwaysTokens = 0
  let cut = false
  for (const i of byPrecedence) {
    const t = tokens(i.body)
    if (!cut && alwaysTokens + t <= o.budget) {
      alwaysTokens += t
      keep.add(i.id)
    } else {
      cut = true
    }
  }

  const content: Instruction[] = []
  const listed: Instruction[] = []
  const manual: Instruction[] = []
  for (const i of ordered) {
    if (i.trigger === 'always') {
      const t = tokens(i.body)
      if (keep.has(i.id)) {
        content.push(i)
        item(i, 'sempre', 'content', t)
      } else {
        item(i, 'sempre (fora do orçamento)', 'dropped', t)
      }
    } else if (i.trigger === 'glob') {
      let hit: { glob: string; path: string } | null = null
      for (const g of i.globs) {
        const path = touched.find((p) => matchesGlob(p, g))
        if (path) {
          hit = { glob: g, path }
          break
        }
      }
      if (hit) {
        content.push(i)
        item(i, `glob ${hit.glob} (${hit.path})`, 'content', tokens(i.body))
      }
    } else if (i.trigger === 'model') {
      listed.push(i)
      item(i, 'o modelo decide (nome e descrição)', 'listed', tokens(listedLine(i)))
    } else if (i.trigger === 'manual' && manualSet.has(i.name)) {
      manual.push(i)
      item(i, `citado como @${i.name}`, 'content', tokens(i.body))
    }
  }
  listed.sort((a, b) => a.name.localeCompare(b.name))
  const dropped = [...items.values()].some((x) => x.included === 'dropped')
  return {
    always: content,
    listed,
    manual,
    active: {
      chatId: o.chatId ?? '',
      items: [...items.values()],
      alwaysTokens,
      alwaysBudget: o.budget,
      overBudget: dropped
    }
  }
}

/** Texto das instruções com conteúdo (arquivos no formato `Contents of <caminho>:` de sempre). */
export function renderInstructionText(content: Instruction[]): string {
  return content
    .map((i) => {
      const body = i.body.trim()
      if (!body) return ''
      if (i.source.type === 'file') return sectionText(i.source.path, body)
      return `Instruction "${i.name}" (${i.kind}, ${i.scope} scope):\n\n${body}`
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Bloco incluído antes do texto do usuário para cada `manual` citado. */
export function renderManualBlocks(manual: Instruction[]): string {
  return manual
    .map((i) => `<instruction name="${i.name}" kind="${i.kind}">\n${i.body.trim()}\n</instruction>`)
    .join('\n\n')
}

/** Contexto de resolução de um chat. */
export interface InstructionContext {
  projectRoot: string
  projectId: string | null
  groupId: string | null
  chatId: string | null
  cfg: AppConfig
  /** Turno de subagente (chat filho). */
  subagent?: boolean
}

/** Instruções dinâmicas (ex.: memória) que entram como candidatas na resolução. */
export type InstructionProvider = (c: InstructionContext) => Instruction[]
/** Seção extra no fim do system prompt (ex.: `# Memory`); `null`/vazio = sem seção. */
export type PromptSectionProvider = (c: InstructionContext) => string | null

export interface InstructionResolver {
  /** Todos os candidatos do contexto: descobertos (com toggles) + banco + provedores. */
  candidates(c: InstructionContext): Instruction[]
  /** Resolve e guarda o `active` do chat (visto por `instructions.active`). */
  resolve(c: InstructionContext, manualNames?: string[]): ResolvedInstructions
  /** Seções extras (provedores), na ordem de registro. */
  sections(c: InstructionContext): string[]
  /**
   * Mensagem do usuário: `@nome`/`/nome` de itens `manual` viram blocos antes do texto.
   * Devolve o texto final e os nomes achados (lembrados para o `active` do chat).
   */
  expandManual(c: InstructionContext, text: string): { text: string; names: string[] }
  /** Registra um caminho (relativo ao projeto) tocado pelo chat. */
  recordTouched(chatId: string, path: string): void
  /** Último `active` resolvido do chat (ou `null`). */
  lastActive(chatId: string): ActiveInstructions | null
  registerProvider(p: InstructionProvider): () => void
  registerSection(p: PromptSectionProvider): () => void
}

export interface InstructionResolverDeps {
  repo?: InstructionRepo | null
  touched?: TouchedPathRepo | null
}

/** Serviço de instruções do host; sem repos, resolve só o que está no disco. */
export function createInstructionResolver(deps: InstructionResolverDeps = {}): InstructionResolver {
  const providers: InstructionProvider[] = []
  const sectionProviders: PromptSectionProvider[] = []
  const lastActive = new Map<string, ActiveInstructions>()
  const lastManual = new Map<string, string[]>()

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  const candidates = (c: InstructionContext): Instruction[] => {
    const toggles = deps.repo
      ? safe(() => deps.repo!.toggles(), new Map<string, boolean>())
      : new Map()
    const discovered = safe(
      () => discoverInstructions(c.projectRoot, c.projectId, c.cfg, toggles),
      [] as Instruction[]
    )
    const stored = deps.repo
      ? safe(
          () =>
            deps.repo!.listForContext({
              projectId: c.projectId,
              groupId: c.groupId,
              chatId: c.chatId
            }),
          [] as Instruction[]
        )
      : []
    const dynamic = providers.flatMap((p) => safe(() => p(c), [] as Instruction[]))
    return [...discovered, ...stored, ...dynamic]
  }

  const resolve = (c: InstructionContext, manualNames?: string[]): ResolvedInstructions => {
    const touchedPaths =
      c.chatId && deps.touched ? safe(() => deps.touched!.list(c.chatId!), [] as string[]) : []
    const r = resolveInstructions(candidates(c), {
      chatId: c.chatId,
      touchedPaths,
      manualNames: manualNames ?? (c.chatId ? (lastManual.get(c.chatId) ?? []) : []),
      budget: c.cfg.alwaysInstructionBudgetTokens ?? 8000
    })
    if (c.chatId) lastActive.set(c.chatId, r.active)
    return r
  }

  const register = <T>(list: T[], p: T): (() => void) => {
    list.push(p)
    return () => {
      const i = list.indexOf(p)
      if (i >= 0) list.splice(i, 1)
    }
  }

  return {
    candidates,
    resolve,
    sections: (c) =>
      sectionProviders
        .map((p) => safe(() => p(c), null))
        .filter((s): s is string => !!s && !!s.trim()),
    expandManual(c, text) {
      const manualItems = candidates(c).filter((i) => i.enabled && i.trigger === 'manual')
      const names = mentionedNames(text, new Set(manualItems.map((i) => i.name)))
      if (c.chatId) lastManual.set(c.chatId, names)
      if (!names.length) return { text, names }
      const r = resolveInstructions(manualItems, {
        chatId: c.chatId,
        touchedPaths: [],
        manualNames: names,
        budget: Infinity
      })
      const blocks = renderManualBlocks(r.manual)
      return { text: blocks ? `${blocks}\n\n${text}` : text, names }
    },
    recordTouched(chatId, path) {
      if (!deps.touched || !path) return
      const p = normalizeSlashes(path)
      safe(() => deps.touched!.add(chatId, p), undefined)
    },
    lastActive: (chatId) => lastActive.get(chatId) ?? null,
    registerProvider: (p) => register(providers, p),
    registerSection: (p) => register(sectionProviders, p)
  }
}
