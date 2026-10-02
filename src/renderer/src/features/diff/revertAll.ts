import type { ChangedFileSummary } from '@shared/domain'

/** Arquivos em que o chat mexeu (alvo do "Recusar tudo deste chat"). */
export function chatRevertTargets(files: ChangedFileSummary[], chatId: string): string[] {
  return files.filter((f) => f.chatIds.includes(chatId)).map((f) => f.path)
}

export interface RevertAllTally {
  reverted: number
  conflicts: number
  failed: number
}

const files = (n: number): string => (n === 1 ? '1 arquivo' : `${n} arquivos`)

/** Resumo do toast ao fim do "Recusar tudo deste chat". */
export function revertAllSummary(t: RevertAllTally): {
  level: 'success' | 'warning' | 'error'
  text: string
} {
  const total = t.reverted + t.conflicts + t.failed
  if (total === 0) return { level: 'warning', text: 'Nada para recusar neste chat.' }
  const parts: string[] = []
  if (t.reverted > 0) parts.push(`${files(t.reverted)} revertido${t.reverted === 1 ? '' : 's'}`)
  if (t.conflicts > 0) parts.push(`${t.conflicts} em conflito`)
  if (t.failed > 0) parts.push(`${t.failed} com erro`)
  const level = t.failed === total ? 'error' : t.reverted === total ? 'success' : 'warning'
  return { level, text: parts.join(' · ') }
}
