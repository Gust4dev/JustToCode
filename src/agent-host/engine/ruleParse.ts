import type { AppConfig, Chat, SettingSuggestion } from '@shared/domain'
import type { ModelClient } from '../model/types'
import { isReasoningLevel } from '../model/reasoning'

const PARSE_TIMEOUT_MS = 30_000
const MAX_INPUT_CHARS = 4000

type SuggestionKey = SettingSuggestion['key']
const COMBO_KEYS: SuggestionKey[] = ['subagentCombo', 'summarizerModel']
const REASONING_KEYS: SuggestionKey[] = ['reasoning', 'subagentReasoning']
const NUMBER_KEYS: SuggestionKey[] = ['tokenBudget', 'maxIterations']
export const SUGGESTION_KEYS: SuggestionKey[] = [...REASONING_KEYS, ...COMBO_KEYS, ...NUMBER_KEYS]

/** Prompt fixo (os testes o usam para distinguir o request). */
export const RULE_PARSE_SYSTEM = `You split a user's instruction for a coding agent into a persistent rule and optional chat setting changes.
Answer ONLY with one JSON object, no markdown, in this exact shape:
{"ruleText": string, "suggestions": [{"key": string, "value": string | number | null}]}
- "ruleText": the behavioral rule, rewritten clearly in the user's language, without the setting changes. Use "" if the text only changes settings.
- Allowed keys and values:
  - "reasoning": "low" | "medium" | "high" | null (reasoning effort of this chat)
  - "subagentReasoning": "low" | "medium" | "high" | null (reasoning effort of subagents)
  - "subagentCombo": one of the available models, or null (model used by subagents)
  - "summarizerModel": one of the available models, or null (model that summarizes the conversation)
  - "tokenBudget": positive integer or null (token budget of a turn; null = no limit)
  - "maxIterations": positive integer or null (iterations per turn; null = no limit)
- Only suggest a setting the user clearly asked for. Otherwise "suggestions": [].`

const LEVEL_LABEL: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto' }

/** Rótulo pt-BR do chip de ajuste. */
export function suggestionLabel(key: SuggestionKey, value: string | number | null): string {
  const v = value === null ? null : String(value)
  switch (key) {
    case 'reasoning':
      return v ? `Reasoning do chat: ${LEVEL_LABEL[v] ?? v}` : 'Reasoning do chat: padrão'
    case 'subagentReasoning':
      return v
        ? `Reasoning dos subagents: ${LEVEL_LABEL[v] ?? v}`
        : 'Reasoning dos subagents: padrão'
    case 'subagentCombo':
      return v ? `Combo dos subagents: ${v}` : 'Combo dos subagents: padrão'
    case 'summarizerModel':
      return v ? `Modelo do resumo: ${v}` : 'Modelo do resumo: padrão'
    case 'tokenBudget':
      return v ? `Orçamento: ${Number(v).toLocaleString('pt-BR')} tokens` : 'Orçamento: sem limite'
    case 'maxIterations':
      return v ? `Limite de iterações: ${v}` : 'Limite de iterações: sem limite'
  }
}

/** Valida uma sugestão crua; null se a chave/valor não for permitido. */
export function validateSuggestion(
  raw: unknown,
  models: string[] | null
): SettingSuggestion | null {
  if (!raw || typeof raw !== 'object') return null
  const { key, value } = raw as { key?: unknown; value?: unknown }
  if (typeof key !== 'string' || !(SUGGESTION_KEYS as string[]).includes(key)) return null
  const k = key as SuggestionKey
  let v: string | number | null
  if (value === null || value === undefined) {
    v = null
  } else if (REASONING_KEYS.includes(k)) {
    if (!isReasoningLevel(value)) return null
    v = value
  } else if (COMBO_KEYS.includes(k)) {
    // Combos só da lista `models.list` (sem a lista, não dá para validar).
    if (typeof value !== 'string' || !models || !models.includes(value.trim())) return null
    v = value.trim()
  } else {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
    v = n
  }
  return { key: k, value: v, label: suggestionLabel(k, v) }
}

/** Extrai o objeto JSON da resposta (tolera `<think>`, cercas de código e texto em volta). */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Resposta do modelo → resultado validado; inválida → `{ ruleText: text, suggestions: [] }`. */
export function interpretRuleResponse(
  text: string,
  raw: string,
  models: string[] | null
): { ruleText: string; suggestions: SettingSuggestion[] } {
  const fallback = { ruleText: text, suggestions: [] }
  const json = extractJson(raw)
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fallback
  const { ruleText, suggestions } = json as { ruleText?: unknown; suggestions?: unknown }
  if (typeof ruleText !== 'string') return fallback
  const list = Array.isArray(suggestions) ? suggestions : []
  const out: SettingSuggestion[] = []
  for (const s of list) {
    const v = validateSuggestion(s, models)
    // Uma sugestão por chave (a primeira vale).
    if (v && !out.some((o) => o.key === v.key)) out.push(v)
  }
  const rule = ruleText.trim()
  if (!rule && !out.length) return fallback
  return { ruleText: rule, suggestions: out }
}

/** Combos leves para classificar, em ordem: lightCombo → defaultCombo → combo do chat. */
export function ruleParseModels(cfg: AppConfig, chat: Chat): string[] {
  const out: string[] = []
  for (const m of [cfg.lightCombo, cfg.defaultCombo, chat.combo]) {
    const t = (m ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

export interface RuleParseDeps {
  model: ModelClient
  getConfig: () => AppConfig
}

/**
 * `/regra <texto>`: separa a regra dos ajustes do chat usando um combo leve.
 * Qualquer falha (modelo, JSON, validação) cai em `{ ruleText: text, suggestions: [] }`.
 */
export async function parseRule(
  d: RuleParseDeps,
  chat: Chat,
  text: string
): Promise<{ ruleText: string; suggestions: SettingSuggestion[] }> {
  const fallback = { ruleText: text, suggestions: [] }
  const combos = ruleParseModels(d.getConfig(), chat)
  if (!text.trim() || !combos.length) return fallback
  let models: string[] | null = null
  try {
    models = (await d.model.listModels()).map((m) => m.id)
  } catch {
    models = null // sem lista: sugestões de combo são descartadas
  }
  const available = models?.length ? models.join(', ') : '(unknown)'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS)
  try {
    for (const m of combos) {
      if (controller.signal.aborted) break
      try {
        let raw = ''
        const stream = d.model.stream(
          {
            model: m,
            messages: [
              { role: 'system', content: RULE_PARSE_SYSTEM },
              {
                role: 'user',
                content: `Available models: ${available}\n\nInstruction:\n${text.slice(0, MAX_INPUT_CHARS)}`
              }
            ],
            tools: []
          },
          controller.signal
        )
        for await (const ev of stream) if (ev.type === 'text_delta') raw += ev.delta
        if (raw.trim()) return interpretRuleResponse(text, raw, models)
      } catch {
        // tenta o próximo combo
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return fallback
}
