import { RpcError } from '@shared/rpc'

/** Limites da instalação: arquivos baixados por operação e tamanho por arquivo. */
export const MAX_FILES = 200
export const MAX_FILE_BYTES = 1024 * 1024

export const DEFAULT_API_BASE = 'https://api.github.com'
export const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com'

export interface GithubTarget {
  owner: string
  repo: string
  /** `null` = branch padrão do repositório. */
  ref: string | null
  /** Pasta (`tree`) ou arquivo (`blob`) dentro do repo; `''` = raiz. */
  path: string
  kind: 'repo' | 'tree' | 'blob'
}

const NAME = /^[A-Za-z0-9_.-]+$/

/**
 * Aceita `https://github.com/<o>/<r>[.git]`, `.../tree/<ref>/<pasta>` e `.../blob/<ref>/<arquivo>`.
 * O `ref` é um único segmento (branches com `/` não são suportados na URL).
 */
export function parseGithubUrl(input: string): GithubTarget {
  const bad = (): never => {
    throw new RpcError(`URL do GitHub inválida: ${input}`, 'INVALID_URL')
  }
  let u: URL
  try {
    u = new URL(String(input ?? '').trim())
  } catch {
    return bad()
  }
  if (!/^https?:$/.test(u.protocol) || !/^(www\.)?github\.com$/i.test(u.hostname)) bad()
  const parts = u.pathname
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p))
  if (parts.length < 2) bad()
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!NAME.test(owner) || !NAME.test(repo)) bad()
  if (parts.length === 2) return { owner, repo, ref: null, path: '', kind: 'repo' }
  const mode = parts[2]
  if ((mode !== 'tree' && mode !== 'blob') || parts.length < 4) return bad()
  const rest = parts.slice(4)
  if (rest.some((p) => p === '..' || p === '.')) bad()
  if (mode === 'blob' && !rest.length) bad()
  return { owner, repo, ref: parts[3], path: rest.join('/'), kind: mode }
}

export interface TreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  size?: number
}

export interface GithubClientOptions {
  /** `fetch` injetável (testes usam servidor local). */
  fetch?: typeof fetch
  apiBase?: string
  rawBase?: string
  token?: string
}

export interface GithubClient {
  defaultBranch(owner: string, repo: string): Promise<string>
  resolveRef(owner: string, repo: string, ref: string): Promise<string>
  listTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]>
  download(owner: string, repo: string, sha: string, path: string): Promise<Buffer>
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '')
const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

export function createGithubClient(opts: GithubClientOptions = {}): GithubClient {
  const doFetch = opts.fetch ?? fetch
  const api = trimSlash(opts.apiBase ?? process.env.JTC_GITHUB_API_BASE ?? DEFAULT_API_BASE)
  const raw = trimSlash(opts.rawBase ?? process.env.JTC_GITHUB_RAW_BASE ?? DEFAULT_RAW_BASE)
  const token = opts.token ?? process.env.GITHUB_TOKEN

  const get = async (url: string, accept: string): Promise<Response> => {
    const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'JustToCode' }
    if (token) headers.Authorization = `Bearer ${token}`
    let res: Response
    try {
      res = await doFetch(url, { headers })
    } catch (e) {
      throw new RpcError(`Falha ao acessar o GitHub: ${(e as Error).message}`, 'NETWORK')
    }
    if (res.ok) return res
    if (res.status === 404) throw new RpcError(`Não encontrado no GitHub: ${url}`, 'NOT_FOUND')
    if (res.status === 403 || res.status === 429) {
      throw new RpcError('Limite de requisições do GitHub atingido', 'RATE_LIMITED')
    }
    throw new RpcError(`GitHub respondeu ${res.status} para ${url}`, 'GITHUB_ERROR')
  }
  const json = async <T>(path: string): Promise<T> =>
    (await (await get(`${api}${path}`, 'application/vnd.github+json')).json()) as T

  return {
    async defaultBranch(owner, repo) {
      const r = await json<{ default_branch?: string }>(`/repos/${owner}/${repo}`)
      return r.default_branch || 'HEAD'
    },
    async resolveRef(owner, repo, ref) {
      const r = await json<{ sha?: string }>(
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`
      )
      if (!r.sha) throw new RpcError(`Ref sem commit: ${ref}`, 'NOT_FOUND')
      return r.sha
    },
    async listTree(owner, repo, sha) {
      const r = await json<{ tree?: TreeEntry[]; truncated?: boolean }>(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`
      )
      if (r.truncated) throw new RpcError('Repositório grande demais para listar', 'TOO_MANY_FILES')
      return (r.tree ?? []).map((e) => ({ path: e.path, type: e.type, size: e.size }))
    },
    async download(owner, repo, sha, path) {
      const res = await get(`${raw}/${owner}/${repo}/${sha}/${enc(path)}`, '*/*')
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len > MAX_FILE_BYTES) throw tooLarge(path)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_FILE_BYTES) throw tooLarge(path)
      return buf
    }
  }
}

export const tooLarge = (path: string): RpcError =>
  new RpcError(`Arquivo maior que 1 MB: ${path}`, 'TOO_LARGE')
