import type { ReasoningLevel, ReasoningStyle } from '@shared/domain'
import type { ChatRequest } from './types'

export const REASONING_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high']

export const isReasoningLevel = (v: unknown): v is ReasoningLevel =>
  typeof v === 'string' && (REASONING_LEVELS as readonly string[]).includes(v)

/** Variante do modelo com sufixo `(level)` (aceita pelo 9router). */
export const suffixModel = (model: string, level: ReasoningLevel): string => `${model}(${level})`

/**
 * Aplica o reasoning pedido ao request: `param` → `reasoning_effort`; `suffix` → modelo
 * `combo(level)`; `both` → os dois. Sem nível, devolve o request intacto.
 */
export function withReasoning(
  req: ChatRequest,
  level: ReasoningLevel | null | undefined,
  style: ReasoningStyle | undefined
): ChatRequest {
  if (!level) return req
  const s = style ?? 'param'
  return {
    ...req,
    ...(s !== 'param' ? { model: suffixModel(req.model, level) } : {}),
    ...(s !== 'suffix' ? { reasoning: level } : {})
  }
}
