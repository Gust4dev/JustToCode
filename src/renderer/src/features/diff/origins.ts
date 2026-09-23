import type { ChangedFileSummary, ChangeOrigin, RevertConflict } from '@shared/domain'

const ORIGIN_LABEL: Partial<Record<ChangeOrigin, string>> = {
  command: '(comando)',
  external: '(você)',
  ambiguous: '(ambíguo)'
}

/** Rótulos de origem. Mudança de ferramenta sem chat = registro de um revert (até ser aceito). */
export function originLabels(file: ChangedFileSummary): string[] {
  const labels: string[] = []
  if (file.origins.includes('tool') && file.chatIds.length === 0) labels.push('(revertido)')
  for (const o of file.origins) {
    const label = ORIGIN_LABEL[o]
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/** "A", "A e B", "A, B e C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
}

/** Tooltip do ⚠ de um arquivo; null quando não há o que avisar. */
export function fileWarning(file: ChangedFileSummary, names: string[]): string | null {
  if (file.origins.includes('ambiguous'))
    return names.length > 0
      ? `mudança durante comandos de ${joinNames(names)}`
      : 'mudança durante comandos de mais de um chat'
  if (file.chatIds.length > 1) return 'Mais de um chat mexeu neste arquivo'
  return null
}

export type RevertOutcome =
  | { kind: 'reverted' }
  | { kind: 'conflict'; conflict: RevertConflict; message: string | null }
  /** Conflito sem conteúdo (binário, sem blob): só dá para manter o atual ou tentar a reversão. */
  | { kind: 'conflict-bare'; message: string }

export function interpretRevert(r: {
  status: 'reverted' | 'conflict'
  message?: string
  conflict?: RevertConflict
}): RevertOutcome {
  if (r.status !== 'conflict') return { kind: 'reverted' }
  if (r.conflict) return { kind: 'conflict', conflict: r.conflict, message: r.message ?? null }
  return { kind: 'conflict-bare', message: r.message ?? 'O arquivo mudou depois deste chat.' }
}

/** Texto amigável para os erros de `git.commitMessage`. */
export function commitErrorText(code: string | undefined, message: string): string {
  switch (code) {
    case 'NOTHING_TO_COMMIT':
      return 'Nada para commitar: não há mudanças no repositório.'
    case 'NO_MODEL':
      return 'Nenhum modelo configurado. Defina a combo leve ou a padrão nas configurações.'
    case 'EMPTY_RESPONSE':
      return 'O modelo não devolveu nenhuma mensagem. Tente gerar de novo.'
    case 'UNKNOWN_METHOD':
      return 'Esta versão do agent-host ainda não gera mensagens de commit.'
    default:
      return message
  }
}
