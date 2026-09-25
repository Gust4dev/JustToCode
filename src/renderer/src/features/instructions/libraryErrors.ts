import { errorMessage, isUnknownMethod } from '@renderer/features/projects/store'
import { INSTALL_ERRORS } from './libraryLogic'

/** Mensagem amigável para erros de `library.*`. */
export function libraryErrorMessage(e: unknown): string {
  if (isUnknownMethod(e)) return 'O agent-host ainda não suporta instalar do GitHub.'
  const code = (e as { code?: unknown } | null)?.code
  const known = typeof code === 'string' ? INSTALL_ERRORS[code] : undefined
  if (code === 'SUSPICIOUS_CONTENT') return `${known}\n${errorMessage(e)}`
  return known ?? errorMessage(e)
}
