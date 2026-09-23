const tokens = (command: string): string[] => command.trim().split(/\s+/).filter(Boolean)

/**
 * Padrão lembrado para um comando: primeiro token + segundo token se ele não for flag.
 * "npm test --watch" → "npm test"; "ls -la" → "ls".
 */
export function rulePatternFor(command: string): string {
  const t = tokens(command)
  if (t.length === 0) return ''
  if (t.length > 1 && !t[1].startsWith('-') && !t[1].startsWith('/')) return `${t[0]} ${t[1]}`
  return t[0]
}

/** Encadeamento, pipe, redirecionamento ou subexpressão: regra lembrada nunca cobre isso. */
const COMPOUND = /[;&|<>`\n\r]|\$\(/

/**
 * Casa por prefixo de token: "npm test" casa "npm test --watch", não "npm testing".
 * Comando composto ("npm test; rm x") nunca casa.
 */
export function matchesRule(command: string, pattern: string): boolean {
  if (COMPOUND.test(command)) return false
  const p = tokens(pattern)
  if (p.length === 0) return false
  const c = tokens(command)
  if (c.length < p.length) return false
  return p.every((tok, i) => c[i].toLowerCase() === tok.toLowerCase())
}
