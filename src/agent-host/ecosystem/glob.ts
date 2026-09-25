/**
 * Glob mínimo para gatilhos de instrução (sem dependências): `**`, `*`, `?`, `[abc]`, `{a,b}`.
 * Caminhos e padrões são normalizados para `/`; sem diferenciar maiúsculas (Windows).
 * Padrão sem `/` casa o nome do arquivo em qualquer pasta (`*.ts` casa `src/a.ts`).
 */

const cache = new Map<string, RegExp>()

function escape(c: string): string {
  return /[.+^$()|\\]/.test(c) ? `\\${c}` : c
}

function toRegexSource(p: string): string {
  let out = ''
  let braces = 0
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` = zero ou mais pastas; `**` no fim (ou solto) = qualquer coisa.
        const atStart = i === 0 || p[i - 1] === '/'
        i++
        if (p[i + 1] === '/' && atStart) {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const end = p.indexOf(']', i + 1)
      if (end < 0) {
        out += '\\['
      } else {
        const body = p.slice(i + 1, end).replace(/\\/g, '\\\\')
        out += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`
        i = end
      }
    } else if (c === '{') {
      braces++
      out += '(?:'
    } else if (c === '}' && braces > 0) {
      braces--
      out += ')'
    } else if (c === ',' && braces > 0) {
      out += '|'
    } else {
      out += escape(c)
    }
  }
  return out
}

export const normalizeSlashes = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')

function compile(pattern: string): RegExp {
  let re = cache.get(pattern)
  if (!re) {
    const p = normalizeSlashes(pattern.trim()).replace(/^\//, '')
    const anywhere = !p.includes('/')
    const src = toRegexSource(p)
    re = new RegExp(anywhere ? `^(?:.*/)?${src}$` : `^${src}$`, 'i')
    if (cache.size > 500) cache.clear()
    cache.set(pattern, re)
  }
  return re
}

/** `path` (relativo ao projeto) casa `pattern`? Padrão vazio nunca casa. */
export function matchesGlob(path: string, pattern: string): boolean {
  if (!pattern.trim()) return false
  return compile(pattern).test(normalizeSlashes(path))
}
