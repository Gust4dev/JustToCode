import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  DownloadProgress,
  GgufFile,
  GgufMeta,
  GgufRepo,
  HardwareInfo,
  LlamaProfile,
  LocalModel,
  MemoryEstimate
} from '../../shared/components'
import type { ComponentHandlers } from './ipc'
import type { ComponentsContext } from './context'
import { download, type DownloadParams } from './downloader'
import { detectHardware } from './hardware'
import { estimateMemory } from './estimate'
import { readGgufMeta } from './ggufHeader'
import {
  HF_BASE,
  assertRepo,
  assertRepoPath,
  listGgufFiles,
  listTree,
  parseShard,
  resolveUrl,
  searchRepos,
  shardPath
} from './huggingface'

export interface ModelsDeps {
  userData: string
  /** Downloads em andamento (compartilhado com `cancelDownload`). */
  downloads: Map<string, AbortController>
  emitProgress(p: DownloadProgress): void
  getHardware(): Promise<HardwareInfo>
  downloadImpl(p: DownloadParams): Promise<void>
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export interface ModelsService {
  dir(): Promise<string>
  setDir(dir: string): Promise<void>
  local(): Promise<LocalModel[]>
  search(q: string): Promise<GgufRepo[]>
  files(repo: string): Promise<GgufFile[]>
  meta(file: GgufFile): Promise<GgufMeta | null>
  estimate(
    file: GgufFile,
    ctx: number,
    cacheType: LlamaProfile['cacheType'],
    moeOffload?: boolean
  ): Promise<MemoryEstimate>
  download(file: GgufFile): Promise<void>
  remove(path: string): Promise<void>
  /** Destino local de um arquivo do repo: `<dir>/<repo com / → __>/<arquivo>`. */
  destFor(dir: string, repo: string, path: string): string
}

export function downloadId(file: Pick<GgufFile, 'repo' | 'path'>): string {
  return `hf:${file.repo}/${file.path}`
}

/** Caminhos de todos os arquivos de um item (os shards quando for grupo). */
export function groupPaths(path: string): string[] {
  const s = parseShard(path)
  if (!s) return [path]
  return Array.from({ length: s.count }, (_, i) => shardPath(path, i + 1))
}

export function modelDest(dir: string, repo: string, path: string): string {
  assertRepo(repo)
  assertRepoPath(path)
  return join(dir, repo.replace('/', '__'), basename(path))
}

/** `target` está dentro de `root` (e não é o próprio `root`)? */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createModelsService(d: ModelsDeps): ModelsService {
  const configFile = join(d.userData, 'components', 'models.json')
  const opts = { fetchImpl: d.fetchImpl, baseUrl: d.baseUrl }
  const base = d.baseUrl ?? HF_BASE
  const metaCache = new Map<string, Promise<GgufMeta | null>>()

  const readDir = (): string => {
    try {
      const cfg = JSON.parse(readFileSync(configFile, 'utf8')) as { dir?: unknown }
      if (typeof cfg.dir === 'string' && isAbsolute(cfg.dir)) return cfg.dir
    } catch {
      // sem config → padrão
    }
    return join(d.userData, 'models')
  }

  const meta = (file: GgufFile): Promise<GgufMeta | null> => {
    assertRepo(file.repo)
    assertRepoPath(file.path)
    const key = `${file.repo}/${file.path}`
    let p = metaCache.get(key)
    if (!p) {
      // O header fica no primeiro shard.
      p = readGgufMeta(resolveUrl(file.repo, file.path, base), { fetchImpl: d.fetchImpl }).catch(
        () => {
          metaCache.delete(key)
          return null
        }
      )
      metaCache.set(key, p)
    }
    return p
  }

  const walk = async (root: string, out: LocalModel[]): Promise<void> => {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(root, e.name)
      if (e.isDirectory()) await walk(full, out)
      else if (e.isFile() && /\.gguf$/i.test(e.name)) {
        out.push({ path: full, name: e.name, size: (await stat(full)).size })
      }
    }
  }

  return {
    destFor: modelDest,
    async dir() {
      return readDir()
    },
    async setDir(dir) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) {
        throw new Error('models: a pasta de modelos precisa ser um caminho absoluto')
      }
      await mkdir(dir, { recursive: true })
      await mkdir(dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify({ dir: resolve(dir) }, null, 2))
    },
    async local() {
      const out: LocalModel[] = []
      await walk(readDir(), out)
      return out.sort((a, b) => a.path.localeCompare(b.path))
    },
    search: (q) => searchRepos(q, opts),
    files: (repo) => listGgufFiles(repo, opts),
    meta,
    async estimate(file, ctx, cacheType, moeOffload = false) {
      const [m, hw] = await Promise.all([meta(file), d.getHardware()])
      return estimateMemory(file, m, ctx, cacheType, hw, moeOffload)
    },
    async download(file) {
      assertRepo(file.repo)
      assertRepoPath(file.path)
      const dir = readDir()
      const paths = groupPaths(file.path)
      // Hash por shard vem da árvore do repo (o GgufFile do grupo só traz o do shard 1).
      const hashes = new Map<string, { sha256: string | null; size: number }>()
      if (paths.length > 1) {
        for (const e of await listTree(file.repo, opts)) {
          hashes.set(e.path, { sha256: e.lfs?.oid ?? null, size: e.lfs?.size ?? e.size })
        }
      } else {
        hashes.set(file.path, { sha256: file.sha256, size: file.size })
      }
      const id = downloadId(file)
      if (d.downloads.has(id)) throw new Error(`download "${id}" já está em andamento`)
      const ctrl = new AbortController()
      d.downloads.set(id, ctrl)
      const label = basename(file.path)
      let before = 0
      try {
        for (const path of paths) {
          const info = hashes.get(path)
          if (!info) throw new Error(`models: shard ${path} não encontrado no repositório`)
          const dest = modelDest(dir, file.repo, path)
          const last = path === paths[paths.length - 1]
          if (existsSync(dest)) {
            before += info.size
            continue
          }
          await d.downloadImpl({
            id,
            label,
            url: resolveUrl(file.repo, path, base),
            dest,
            sha256: info.sha256,
            signal: ctrl.signal,
            fetchImpl: d.fetchImpl,
            onProgress: (p) =>
              d.emitProgress({
                ...p,
                label,
                received: before + p.received,
                total: file.size || p.total,
                done: p.done && last
              })
          })
          before += info.size
        }
        d.emitProgress({ id, label, received: before, total: file.size, done: true, error: null })
      } finally {
        if (d.downloads.get(id) === ctrl) d.downloads.delete(id)
      }
    },
    async remove(path) {
      const root = readDir()
      if (typeof path !== 'string' || !isInside(root, path) || !/\.gguf$/i.test(path)) {
        throw new Error('models: só é possível remover arquivos .gguf dentro da pasta de modelos')
      }
      const targets = parseShard(path) ? groupPaths(path) : [path]
      for (const t of targets) await rm(t, { force: true })
    }
  }
}

/** Serviço real a partir do contexto (hardware detectado uma vez e reaproveitado). */
export function modelsFromContext(ctx: ComponentsContext): ModelsService {
  let hw: Promise<HardwareInfo> | null = null
  return createModelsService({
    userData: ctx.userData,
    downloads: ctx.downloads,
    emitProgress: ctx.emitProgress,
    getHardware: () => {
      hw ??= detectHardware().catch((e) => {
        hw = null
        throw e
      })
      return hw
    },
    downloadImpl: download
  })
}

/** Handlers `models.*` (task 4.4). */
export function registerModels(
  ctx: ComponentsContext,
  handlers: ComponentHandlers,
  svc: ModelsService = modelsFromContext(ctx)
): void {
  handlers['models.dir'] = () => svc.dir()
  handlers['models.setDir'] = (dir: string) => svc.setDir(dir)
  handlers['models.local'] = () => svc.local()
  handlers['models.search'] = (q: string) => svc.search(q)
  handlers['models.files'] = (repo: string) => svc.files(repo)
  handlers['models.estimate'] = (
    file: GgufFile,
    ctx: number,
    cacheType: LlamaProfile['cacheType'],
    moeOffload?: boolean
  ) => svc.estimate(file, ctx, cacheType, moeOffload)
  handlers['models.download'] = (file: GgufFile) => svc.download(file)
  handlers['models.remove'] = (path: string) => svc.remove(path)
}
