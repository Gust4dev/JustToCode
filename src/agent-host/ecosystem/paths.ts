import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'

/** `~` → `os.homedir()` (só no início: `~`, `~/x`, `~\x`). */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** Chave estável para comparar caminhos (Windows não diferencia maiúsculas). */
export function pathKey(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs
  } catch {
    return -1
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

export function listFiles(root: string, ext: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

interface CacheEntry<T> {
  deps: string[]
  sig: string
  value: T
}

const signature = (deps: string[]): string => deps.map((d) => `${d}:${mtimeOf(d)}`).join('|')

/**
 * Cache com invalidação por mtime: `compute` devolve o valor e os caminhos (arquivos e pastas)
 * de que ele depende; na próxima leitura, se nenhum mtime mudou, reaproveita o valor.
 */
export class MtimeCache<T> {
  private entries = new Map<string, CacheEntry<T>>()

  get(key: string, compute: () => { value: T; deps: string[] }): T {
    const hit = this.entries.get(key)
    if (hit && signature(hit.deps) === hit.sig) return hit.value
    const { value, deps } = compute()
    this.entries.set(key, { deps, sig: signature(deps), value })
    return value
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Pastas nunca percorridas na descoberta recursiva. */
export const SKIP_DIRS = new Set(['node_modules', '.git'])

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Procura `<fileName>` recursivamente a partir de `root` (pastas de profundidade 1..maxDepth).
 * Uma pasta que tem o arquivo não é mais descida. Ignora `node_modules`/`.git`; symlinks só são
 * seguidos se o destino real ficar dentro de `root`. Acrescenta em `deps` as pastas visitadas
 * e os arquivos achados (para o cache por mtime).
 */
export function findMarkerFiles(
  root: string,
  fileName: string,
  maxDepth: number,
  deps: string[]
): string[] {
  const out: string[] = []
  deps.push(root)
  const realRoot = realOrNull(root)
  if (!realRoot) return out
  const visited = new Set<string>([pathKey(realRoot)])
  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (depth >= 1 && entries.some((e) => e.isFile() && e.name === fileName)) {
      const file = join(dir, fileName)
      out.push(file)
      deps.push(file)
      return
    }
    if (depth >= maxDepth) return
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name)) continue
      const child = join(dir, e.name)
      if (e.isSymbolicLink()) {
        const real = realOrNull(child)
        if (!real || !inside(realRoot, real)) continue
        try {
          if (!statSync(real).isDirectory()) continue
        } catch {
          continue
        }
        if (visited.has(pathKey(real))) continue
        visited.add(pathKey(real))
      } else if (!e.isDirectory()) {
        continue
      }
      deps.push(child)
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return out
}
