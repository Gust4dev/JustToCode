import type { GgufFile, GgufRepo } from '../../shared/components'

export const HF_BASE = 'https://huggingface.co'

export interface HfOptions {
  fetchImpl?: typeof fetch
  /** Base da API (testes apontam para um servidor local). */
  baseUrl?: string
}

/** Entrada crua de `/api/models/<repo>/tree/main?recursive=true`. */
export interface HfTreeEntry {
  type: string
  path: string
  size: number
  lfs?: { oid: string; size: number } | null
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i
const QUANT_RE = /(IQ\d_[A-Z]+|Q\d_\d|Q\d(?:_K)?(?:_(?:XL|[SML]))?|MXFP4|BF16|F16|F32)/gi

export function assertRepo(repo: unknown): asserts repo is string {
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.includes('..')) {
    throw new Error(`models: repositório inválido (${String(repo)})`)
  }
}

/** Caminho de arquivo dentro do repo: relativo, sem `..`, terminado em `.gguf`. */
export function assertRepoPath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    !/\.gguf$/i.test(path) ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((s) => s === '..' || s === '.' || s === '')
  ) {
    throw new Error(`models: caminho de arquivo inválido (${String(path)})`)
  }
}

/** Quantização a partir do nome do arquivo (última ocorrência, em maiúsculas). */
export function extractQuant(path: string): string | null {
  const name = path.split('/').pop() ?? path
  const all = [...name.matchAll(QUANT_RE)]
  return all.length ? all[all.length - 1][1].toUpperCase() : null
}

export function parseShard(path: string): { index: number; count: number } | null {
  const m = SHARD_RE.exec(path)
  if (!m) return null
  return { index: Number(m[1]), count: Number(m[2]) }
}

/** Nome do shard `index` de um grupo, a partir do nome de qualquer shard. */
export function shardPath(path: string, index: number): string {
  return path.replace(SHARD_RE, (_m, _i, count: string) => {
    return `-${String(index).padStart(5, '0')}-of-${count}.gguf`
  })
}

export function resolveUrl(repo: string, path: string, baseUrl = HF_BASE): string {
  const p = path.split('/').map(encodeURIComponent).join('/')
  return `${baseUrl}/${repo}/resolve/main/${p}`
}

/** Só os `.gguf`, com shards agrupados (o shard 1 representa o grupo, com `size` somado). */
export function groupGgufFiles(repo: string, entries: HfTreeEntry[]): GgufFile[] {
  const out: GgufFile[] = []
  const groups = new Map<string, GgufFile>()
  for (const e of entries) {
    if (e.type !== 'file' || !/\.gguf$/i.test(e.path)) continue
    const size = e.lfs?.size ?? e.size
    const shard = parseShard(e.path)
    if (!shard) {
      out.push({
        repo,
        path: e.path,
        size,
        sha256: e.lfs?.oid ?? null,
        quant: extractQuant(e.path),
        shardIndex: null,
        shardCount: null
      })
      continue
    }
    const key = shardPath(e.path, 1)
    let g = groups.get(key)
    if (!g) {
      g = {
        repo,
        path: key,
        size: 0,
        sha256: null,
        quant: extractQuant(e.path),
        shardIndex: 1,
        shardCount: shard.count
      }
      groups.set(key, g)
      out.push(g)
    }
    g.size += size
    if (shard.index === 1) g.sha256 = e.lfs?.oid ?? null
  }
  return out
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`Hugging Face respondeu ${res.status} para ${url}`)
  return await res.json()
}

interface HfModelRow {
  id?: string
  modelId?: string
  downloads?: number
  likes?: number
  lastModified?: string
  createdAt?: string
}

export async function searchRepos(q: string, opts: HfOptions = {}): Promise<GgufRepo[]> {
  const base = opts.baseUrl ?? HF_BASE
  const params = new URLSearchParams({
    search: String(q ?? '').trim(),
    filter: 'gguf',
    sort: 'downloads',
    direction: '-1',
    limit: '25'
  })
  const rows = (await getJson(`${base}/api/models?${params}`, opts.fetchImpl ?? fetch)) as unknown
  if (!Array.isArray(rows)) return []
  return (rows as HfModelRow[])
    .filter((r) => typeof (r.id ?? r.modelId) === 'string')
    .map((r) => ({
      id: (r.id ?? r.modelId) as string,
      downloads: Number(r.downloads ?? 0),
      likes: Number(r.likes ?? 0),
      updatedAt: r.lastModified ?? r.createdAt ?? null
    }))
}

export async function listTree(repo: string, opts: HfOptions = {}): Promise<HfTreeEntry[]> {
  assertRepo(repo)
  const base = opts.baseUrl ?? HF_BASE
  const rows = await getJson(
    `${base}/api/models/${repo}/tree/main?recursive=true`,
    opts.fetchImpl ?? fetch
  )
  return Array.isArray(rows) ? (rows as HfTreeEntry[]) : []
}

export async function listGgufFiles(repo: string, opts: HfOptions = {}): Promise<GgufFile[]> {
  return groupGgufFiles(repo, await listTree(repo, opts))
}
