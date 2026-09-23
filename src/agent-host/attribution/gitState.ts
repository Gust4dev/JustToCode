import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from '../blobs'
import { git } from './git'

/** Arquivos acima deste tamanho entram só com hash (sem blob). */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024

export interface FileState {
  /** sha256 do conteúdo atual; null = arquivo não existe. */
  hash: string | null
  /** Hash do blob guardado no BlobStore; null = removido ou grande demais. */
  blobHash: string | null
}

export interface GitSnapshot {
  /** Caminho relativo à raiz do projeto (com `/`) → estado. */
  files: Map<string, FileState>
}

export const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/** Prefixo da raiz do projeto dentro do repositório (ex.: `sub/`), ou null se não for repo git. */
async function repoPrefix(root: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--show-prefix'])
  if (r.code !== 0) return null
  return r.stdout.toString('utf8').trim()
}

/**
 * Caminhos sujos (modificados, novos, removidos, renomeados — os dois lados do renome)
 * sob a raiz do projeto, relativos a ela. Ignorados pelo git não aparecem.
 */
export async function dirtyPaths(root: string): Promise<string[]> {
  const prefix = await repoPrefix(root)
  if (prefix === null) return []
  const r = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
    '--',
    '.'
  ])
  if (r.code !== 0) return []
  const tokens = r.stdout.toString('utf8').split('\0')
  const out = new Set<string>()
  const add = (p: string): void => {
    if (!p || !p.startsWith(prefix)) return
    const rel = p.slice(prefix.length)
    if (rel && !rel.endsWith('/')) out.add(rel)
  }
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    add(entry.slice(3))
    // Em -z, renome/cópia traz o caminho de origem como token seguinte.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') add(tokens[++i] ?? '')
  }
  return [...out].sort()
}

/** Lê o conteúdo atual de cada caminho; ≤ 5 MB guarda blob, acima só hash. Pastas são ignoradas. */
export async function snapshot(
  root: string,
  blobs: BlobStore,
  paths: string[]
): Promise<GitSnapshot> {
  const files = new Map<string, FileState>()
  for (const rel of paths) {
    const abs = join(root, rel)
    let size: number
    try {
      const st = await stat(abs)
      if (!st.isFile()) continue
      size = st.size
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        files.set(rel, { hash: null, blobHash: null })
        continue
      }
      throw e
    }
    const buf = await readFile(abs)
    if (size <= MAX_BLOB_BYTES && buf.length <= MAX_BLOB_BYTES) {
      const h = blobs.put(buf)
      files.set(rel, { hash: h, blobHash: h })
    } else {
      files.set(rel, { hash: sha256(buf), blobHash: null })
    }
  }
  return { files }
}

/**
 * Conteúdo do arquivo no índice (ou no commit `rev`, se dado), como ficaria no disco após
 * checkout (filtros de EOL/smudge aplicados). null se o caminho não é rastreado.
 */
export async function indexContent(root: string, rel: string, rev = ''): Promise<Buffer | null> {
  const r = await git(root, ['cat-file', '--filters', `${rev}:./${rel}`])
  return r.code === 0 ? r.stdout : null
}

/** Oid do HEAD, ou null (repo sem commits / não é repo). */
export async function headOid(root: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null
}

/** Arquivos que diferem entre `rev` e a árvore de trabalho, relativos à raiz do projeto. */
export async function changedSince(root: string, rev: string): Promise<string[]> {
  const r = await git(root, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--relative',
    rev,
    '--',
    '.'
  ])
  if (r.code !== 0) return []
  return r.stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
}
