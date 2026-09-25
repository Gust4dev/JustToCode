import type { SettingSuggestion } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { isUnknownMethod } from '@renderer/features/projects/store'

export interface RuleDraft {
  ruleText: string
  suggestions: SettingSuggestion[]
}

/**
 * `rules.parse` do texto de `/regra`. Host sem o método (Task 3.B pendente) → a regra é o texto
 * inteiro, sem sugestões.
 */
export async function parseRule(chatId: string, text: string): Promise<RuleDraft> {
  try {
    return await call('rules.parse', { chatId, text })
  } catch (e) {
    if (isUnknownMethod(e)) return { ruleText: text, suggestions: [] }
    throw e
  }
}
