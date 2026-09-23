import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ComponentId,
  ComponentStatus,
  LlamaBackend,
  LlamaProfile,
  LlamaRelease
} from '../../shared/components'
import type { ComponentHandlers } from './ipc'
import type { ComponentsContext } from './context'
import type { DownloadParams } from './downloader'
import type { ProcessSupervisor } from './supervisor'
import { checkHealth } from './supervisor'
import { ProfileStore, buildArgs, validateProfile } from './profiles'

export const LLAMA_RELEASES_URL =
  'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15'
export const LLAMA_BACKENDS: readonly LlamaBackend[] = ['cuda-12.4', 'cuda-13.4', 'vulkan', 'cpu']
const SERVER_EXE = 'llama-server.exe'
const RELEASES_TTL_MS = 30 * 60 * 1000
const RELEASES_RETRY_MS = 5 * 60 * 1000
const PER_BACKEND = 3

/** Asset com o SHA-256 que a API do GitHub publica em `digest` (quando houver). */
export interface LlamaAsset {
  name: string
  url: string
  size: number
  sha256: string | null
}
export interface LlamaReleaseInfo extends LlamaRelease {
  assets: LlamaAsset[]
}
export interface LlamaCurrent {
  tag: string
  backend: LlamaBackend
  dir: string
}

interface GhAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
  digest?: unknown
}
interface GhRelease {
  tag_name?: unknown
  draft?: unknown
  assets?: unknown
}

const isCuda = (b: LlamaBackend): boolean => b.startsWith('cuda-')
const tagNum = (tag: string): number => Number(/^b(\d+)$/.exec(tag)?.[1] ?? -1)

function toAsset(a: GhAsset | undefined): LlamaAsset | null {
  if (!a || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') return null
  const m = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest) : null
  return {
    name: a.name,
    url: a.browser_download_url,
    size: typeof a.size === 'number' ? a.size : 0,
    sha256: m ? m[1].toLowerCase() : null
  }
}

/**
 * Seleciona, por backend, as releases com `llama-<tag>-bin-win-<backend>-x64.zip` (+ o
 * `cudart-llama-bin-win-<cuda>-x64.zip` quando CUDA) e devolve as 3 mais recentes de cada.
 */
export function parseReleases(json: unknown): LlamaReleaseInfo[] {
  if (!Array.isArray(json)) throw new Error('resposta inesperada da API do GitHub')
  const rels = (json as GhRelease[])
    .filter((r) => r && typeof r.tag_name === 'string' && r.draft !== true)
    .sort((a, b) => tagNum(b.tag_name as string) - tagNum(a.tag_name as string))
  const out: LlamaReleaseInfo[] = []
  for (const backend of LLAMA_BACKENDS) {
    let n = 0
    for (const r of rels) {
      if (n >= PER_BACKEND) break
      const tag = r.tag_name as string
      const assets = Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []
      const find = (name: string): LlamaAsset | null =>
        toAsset(assets.find((a) => a?.name === name))
      const main = find(`llama-${tag}-bin-win-${backend}-x64.zip`)
      if (!main) continue
      const list = [main]
      if (isCuda(backend)) {
        const cudart = find(`cudart-llama-bin-win-${backend}-x64.zip`)
        if (!cudart) continue
        list.push(cudart)
      }
      out.push({ tag, backend, assets: list })
      n++
    }
  }
  return out
}

/** `tar` do Windows (bsdtar, lê zip). Evita o GNU tar do Git que porventura esteja no PATH. */
export function systemTar(): string {
  if (process.platform !== 'win32') return 'tar'
  const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(p) ? p : 'tar'
}

function defaultExec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) =>
      err ? reject(new Error(`${cmd} falhou: ${String(stderr).trim() || err.message}`)) : resolve()
    )
  })
}

/** Pasta que contém `llama-server.exe` (a raiz ou uma subpasta direta). */
export function findServerDir(root: string): string | null {
  if (existsSync(join(root, SERVER_EXE))) return root
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const e of entries) {
    const d = join(root, e)
    try {
      if (statSync(d).isDirectory() && existsSync(join(d, SERVER_EXE))) return d
    } catch {
      /* ignora */
    }
  }
  return null
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export interface LlamaDeps {
  userData: string
  supervisor: Pick<ProcessSupervisor, 'start' | 'stop' | 'managedPid'>
  startDownload(p: Omit<DownloadParams, 'signal' | 'onProgress'>): Promise<void>
  emitLog(e: { id: ComponentId; line: string }): void
  fetchImpl?: typeof fetch
  releasesUrl?: string
  /** Executa um comando (usado para `tar -xf`). */
  exec?: (cmd: string, args: string[]) => Promise<void>
  health?: (url: string) => Promise<boolean>
  modelExists?: (path: string) => boolean
  healthTimeoutMs?: number
  pollMs?: number
  now?: () => number
}

export class LlamaManager {
  readonly root: string
  readonly profiles: ProfileStore
  private cache: { at: number; data: LlamaReleaseInfo[] } | null = null
  private failedAt = -Infinity
  private readonly now: () => number
  private readonly health: (url: string) => Promise<boolean>

  constructor(private readonly d: LlamaDeps) {
    this.root = join(d.userData, 'llama')
    this.profiles = new ProfileStore(join(this.root, 'profiles.json'), d.modelExists)
    this.now = d.now ?? Date.now
    this.health = d.health ?? ((u) => checkHealth(u))
  }

  private log(line: string): void {
    this.d.emitLog({ id: 'llama', line })
  }

  private get currentFile(): string {
    return join(this.root, 'current.json')
  }
  private get runningFile(): string {
    return join(this.root, 'running.json')
  }

  current(): LlamaCurrent | null {
    const c = readJson<LlamaCurrent>(this.currentFile)
    return c && typeof c.dir === 'string' && typeof c.tag === 'string' ? c : null
  }

  /** Releases (cache de 30 min). */
  async releases(): Promise<LlamaReleaseInfo[]> {
    if (this.cache && this.now() - this.cache.at < RELEASES_TTL_MS) return this.cache.data
    const fetchImpl = this.d.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(this.d.releasesUrl ?? LLAMA_RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JustToCode' },
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) {
        throw new Error(
          res.status === 403 || res.status === 429
            ? 'limite de requisições da API do GitHub atingido; tente mais tarde'
            : `GitHub respondeu HTTP ${res.status}`
        )
      }
      const data = parseReleases(await res.json())
      this.cache = { at: this.now(), data }
      return data
    } catch (e) {
      this.failedAt = this.now()
      throw e
    }
  }

  /** Última tag do backend sem insistir na rede se a última tentativa falhou há pouco. */
  private async latestTag(backend: LlamaBackend): Promise<string | null> {
    const fresh = this.cache && this.now() - this.cache.at < RELEASES_TTL_MS
    if (!fresh && this.now() - this.failedAt < RELEASES_RETRY_MS) {
      return this.cache?.data.find((r) => r.backend === backend)?.tag ?? null
    }
    try {
      return (await this.releases()).find((r) => r.backend === backend)?.tag ?? null
    } catch {
      return null
    }
  }

  async install(backend: LlamaBackend): Promise<void> {
    if (!LLAMA_BACKENDS.includes(backend)) throw new Error(`backend inválido: ${String(backend)}`)
    if (this.d.supervisor.managedPid('llama') !== null) {
      throw new Error('STOP_FIRST: pare o llama-server antes de instalar outra versão')
    }
    const rel = (await this.releases()).find((r) => r.backend === backend)
    if (!rel) throw new Error(`nenhuma release recente do llama.cpp com o backend ${backend}`)

    const dlDir = join(this.root, '_downloads')
    const zips: string[] = []
    for (const a of rel.assets) {
      const dest = join(dlDir, a.name)
      this.log(`[baixando ${a.name}]`)
      await this.d.startDownload({
        id: `llama:${a.name}`,
        label: a.name,
        url: a.url,
        dest,
        sha256: a.sha256
      })
      zips.push(dest)
    }

    const target = join(this.root, `${rel.tag}-${backend}`)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    const exec = this.d.exec ?? defaultExec
    for (const z of zips) {
      this.log(`[extraindo ${z}]`)
      await exec(systemTar(), ['-xf', z, '-C', target])
    }
    const dir = findServerDir(target)
    if (!dir) throw new Error(`${SERVER_EXE} não encontrado no pacote ${rel.tag} (${backend})`)
    await writeJson(this.currentFile, { tag: rel.tag, backend, dir } satisfies LlamaCurrent)
    for (const z of zips) await rm(z, { force: true })
    this.log(`[llama.cpp ${rel.tag} (${backend}) instalado em ${dir}]`)
  }

  private async portFor(): Promise<number> {
    const r = readJson<{ port?: unknown }>(this.runningFile)
    if (r && typeof r.port === 'number') return r.port
    return (await this.profiles.list())[0]?.port ?? 8080
  }

  async status(message: string | null = null): Promise<ComponentStatus> {
    const cur = this.current()
    const installed = !!cur && existsSync(join(cur.dir, SERVER_EXE))
    const pid = this.d.supervisor.managedPid('llama')
    const port = await this.portFor()
    const url = `http://127.0.0.1:${port}`
    const healthy = await this.health(`${url}/health`)
    const ownership = pid !== null ? 'managed' : healthy ? 'external' : 'stopped'
    return {
      id: 'llama',
      installed,
      version: installed ? cur.tag : null,
      latestVersion: await this.latestTag(cur?.backend ?? 'cuda-12.4'),
      running: pid !== null || healthy,
      ownership,
      pid,
      url: ownership === 'stopped' ? null : url,
      healthy,
      message
    }
  }

  async start(profileId?: string): Promise<ComponentStatus> {
    const cur = this.current()
    if (!cur || !existsSync(join(cur.dir, SERVER_EXE))) {
      throw new Error('llama.cpp não está instalado')
    }
    const list = await this.profiles.list()
    const profile: LlamaProfile | undefined = profileId
      ? list.find((p) => p.id === profileId)
      : list[0]
    if (!profile) throw new Error(`perfil não encontrado: ${String(profileId)}`)
    validateProfile(profile, this.d.modelExists)

    const url = `http://127.0.0.1:${profile.port}`
    const healthUrl = `${url}/health`
    if (this.d.supervisor.managedPid('llama') === null && (await this.health(healthUrl))) {
      throw new Error(
        `a porta ${profile.port} já tem um servidor respondendo; pare-o ou mude a porta`
      )
    }
    await this.d.supervisor.start({
      id: 'llama',
      command: join(cur.dir, SERVER_EXE),
      args: buildArgs(profile),
      cwd: cur.dir,
      healthUrl
    })
    await writeJson(this.runningFile, { profileId: profile.id, port: profile.port })

    const deadline = this.now() + (this.d.healthTimeoutMs ?? 120_000)
    const poll = this.d.pollMs ?? 1000
    for (;;) {
      if (await this.health(healthUrl)) return this.status()
      if (this.d.supervisor.managedPid('llama') === null) {
        return this.status('o llama-server encerrou durante o carregamento (veja o log)')
      }
      if (this.now() >= deadline) {
        return this.status('o llama-server não respondeu em /health a tempo (ainda carregando?)')
      }
      await new Promise((r) => setTimeout(r, poll))
    }
  }

  async stop(): Promise<ComponentStatus> {
    if (this.d.supervisor.managedPid('llama') === null) {
      const s = await this.status()
      return s.ownership === 'external'
        ? { ...s, message: 'llama-server externo (não iniciado pelo app): pare-o manualmente' }
        : s
    }
    await this.d.supervisor.stop('llama')
    return this.status()
  }
}

/** Handlers `llama.*`, status provider e start/stop do `llama`. */
export function registerLlama(
  ctx: ComponentsContext,
  handlers: ComponentHandlers,
  deps: Partial<LlamaDeps> = {}
): LlamaManager {
  const mgr = new LlamaManager({
    userData: ctx.userData,
    supervisor: ctx.supervisor,
    startDownload: (p) => ctx.startDownload(p),
    emitLog: (e) => ctx.emitLog(e),
    ...deps
  })
  ctx.statusProviders.set('llama', () => mgr.status())
  ctx.starters.set('llama', (profileId) => mgr.start(profileId))
  ctx.stoppers.set('llama', () => mgr.stop())
  handlers['llama.releases'] = () => mgr.releases()
  handlers['llama.install'] = async (backend: LlamaBackend) => {
    try {
      await mgr.install(backend)
    } finally {
      void ctx.refreshStatus('llama')
    }
  }
  handlers['llama.profiles'] = () => mgr.profiles.list()
  handlers['llama.saveProfile'] = (p: LlamaProfile) => mgr.profiles.save(p)
  handlers['llama.deleteProfile'] = (id: string) => mgr.profiles.remove(id)
  return mgr
}
