import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class PathError extends Error {}

function isInside(root: string, target: string): boolean {
  const r = relative(root, target)
  if (r === '') return true
  return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)
}

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** Realpath do ancestral existente mais profundo, reanexando o resto do caminho. */
function realpathLoose(abs: string): string {
  let cur = abs
  const rest: string[] = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    rest.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''))
    cur = parent
  }
  return resolve(realpathSync.native(cur), ...rest)
}

/**
 * Resolve `p` (relativo à raiz ou absoluto) garantindo que fique dentro de `root`,
 * inclusive seguindo symlinks/junctions já existentes. `rel` usa '/'.
 */
export function resolveInside(root: string, p: string): { abs: string; rel: string } {
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, p ?? '.')
  if (!isInside(norm(rootAbs), norm(abs))) {
    throw new PathError(`Path is outside the project root: ${p}`)
  }
  const realRoot = existsSync(rootAbs) ? realpathSync.native(rootAbs) : rootAbs
  const real = realpathLoose(abs)
  if (!isInside(norm(realRoot), norm(real))) {
    throw new PathError(`Path resolves outside the project root (symlink/junction): ${p}`)
  }
  const rel = relative(rootAbs, abs).split(sep).join('/')
  return { abs, rel }
}
