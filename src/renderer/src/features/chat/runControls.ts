import type { QueueState } from '@shared/domain'
import type { BudgetState, PauseReason } from './chatStore'

// Helpers puros do controle de execução (contínuo, orçamento, fila). Só importa de @shared.

/**
 * Lê o campo de orçamento: vazio → null (sem orçamento); `12000`, `200k`, `1.5M`/`1,5M` → tokens;
 * qualquer outra coisa (ou ≤ 0) → undefined (inválido).
 */
export function parseTokenInput(text: string): number | null | undefined {
  const t = text.trim().replace(/[\s_.](?=\d{3}(\D|$))/g, '')
  if (t === '') return null
  const m = /^(\d+(?:[.,]\d+)?)\s*([kKmM])?$/.exec(t)
  if (!m) return undefined
  const base = Number(m[1].replace(',', '.'))
  const mult = !m[2] ? 1 : m[2].toLowerCase() === 'k' ? 1000 : 1_000_000
  const n = Math.round(base * mult)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Valor do campo para um orçamento: null → vazio; múltiplos exatos viram `k`/`M`. */
export function formatTokenInput(n: number | null): string {
  if (n === null) return ''
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`
  return String(n)
}

/** Contínuo = sem limite de iterações (`maxIterations: null`). */
export const isContinuous = (maxIterations: number | null): boolean => maxIterations === null

/** Novo `maxIterations` ao alternar o toggle "Contínuo". */
export function toggleContinuous(maxIterations: number | null, defaultMax: number): number | null {
  return maxIterations === null ? defaultMax : null
}

/** Fração do orçamento usada (0–1), ou null sem orçamento. */
export function budgetFraction(b: BudgetState | null): number | null {
  if (!b || b.budget === null || b.budget <= 0) return null
  return Math.min(1, Math.max(0, b.used / b.budget))
}

export const PAUSE_LABEL: Record<PauseReason, string> = {
  budget: 'Pausado por orçamento de tokens',
  iterations: 'Pausado pelo limite de iterações'
}

/** Texto da faixa da fila ("1 na fila", "3 na fila"); null quando vazia. */
export function queueLabel(q: QueueState | null): string | null {
  const n = q?.items.length ?? 0
  return n === 0 ? null : `${n} na fila`
}

/** A fila está pausada (mostra o banner "Retomar")? */
export const queuePaused = (q: QueueState | null): boolean => !!q?.paused
