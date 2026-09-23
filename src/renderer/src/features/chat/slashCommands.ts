import type { SlashCommand } from '@shared/domain'

// Lógica pura do autocomplete de `/`. Só importa de @shared para rodar nos testes.

/** Texto que ainda está digitando o nome do comando (`/` no início, sem espaço) → o filtro; senão null. */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  return /\s/.test(rest) ? null : rest
}

/** Filtra e ordena: nome começando com o filtro, nome contendo, descrição contendo; empate por nome. */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
  limit = 50
): SlashCommand[] {
  const q = query.toLowerCase()
  const scored: { c: SlashCommand; score: number }[] = []
  for (const c of commands) {
    const name = c.name.toLowerCase()
    const score = name.startsWith(q)
      ? 0
      : name.includes(q)
        ? 1
        : c.description.toLowerCase().includes(q)
          ? 2
          : -1
    if (score >= 0) scored.push({ c, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((s) => s.c)
}

/** `/nome args…` → `{ name, args }`; qualquer outra coisa → null. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}

/** Índice circular para navegar a lista com as setas. */
export function moveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (((index + delta) % length) + length) % length
}

/**
 * Texto a enviar: `/nome args` de um comando conhecido vira o texto expandido pelo host;
 * comando inexistente (ou host sem `ecosystem.expandCommand`) vai como texto normal.
 * Outros erros da expansão sobem para quem chamou.
 */
export async function resolveSlashText(
  text: string,
  commands: SlashCommand[],
  expand: (name: string, args: string) => Promise<{ text: string }>
): Promise<string> {
  const parsed = parseSlashCommand(text)
  if (!parsed || !commands.some((c) => c.name === parsed.name)) return text
  try {
    return (await expand(parsed.name, parsed.args)).text
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'UNKNOWN_METHOD') return text
    throw e
  }
}
