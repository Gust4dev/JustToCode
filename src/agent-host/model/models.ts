import type { ModelInfo } from '@shared/domain'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/** Aceita `{ data: [...] }` (formato OpenAI) ou um array direto. */
export function parseModels(json: unknown): ModelInfo[] {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.data) ? json.data : []
  const out: ModelInfo[] = []
  for (const item of list) {
    if (!isObj(item) || typeof item.id !== 'string' || !item.id) continue
    const caps = isObj(item.capabilities) ? item.capabilities : {}
    const ownedBy = typeof item.owned_by === 'string' ? item.owned_by : ''
    out.push({
      id: item.id,
      ownedBy,
      isCombo: ownedBy === 'combo',
      contextWindow: num(item.context_length) ?? num(caps.contextWindow),
      maxOutput: num(item.max_completion_tokens) ?? num(caps.maxOutput),
      vision: caps.vision === true,
      tools: caps.tools === true
    })
  }
  return out
}
