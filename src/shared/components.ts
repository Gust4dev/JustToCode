// Contratos da F4 (componentes: 9router, llama.cpp, modelos GGUF).
// Sem `electron`/`node:*`: importado por main, preload (só tipos) e renderer.

export type ComponentId = '9router' | 'llama'
export type Ownership = 'managed' | 'external' | 'stopped'
export interface ComponentStatus {
  id: ComponentId
  installed: boolean
  version: string | null
  latestVersion: string | null
  running: boolean
  ownership: Ownership
  pid: number | null
  url: string | null // 9router: http://localhost:20128 ; llama: http://127.0.0.1:<porta>
  healthy: boolean
  message: string | null
}
export interface LlamaProfile {
  id: string
  name: string
  modelPath: string
  ctx: number // -c
  nCpuMoe: number | null // --n-cpu-moe
  ngl: number // -ngl (99 = tudo que couber)
  flashAttn: boolean // -fa on
  cacheType: 'f16' | 'q8_0' | 'q4_0' // --cache-type-k/v
  port: number // --port
  extraArgs: string // args livres, split por espaço respeitando aspas
}
export type LlamaBackend = 'cuda-12.4' | 'cuda-13.4' | 'vulkan' | 'cpu'
export interface LlamaRelease {
  tag: string
  backend: LlamaBackend
  assets: { name: string; url: string; size: number }[]
}
export interface HardwareInfo {
  gpuName: string | null
  vramMB: number | null
  driver: string | null
  ramMB: number
}
export interface GgufRepo {
  id: string
  downloads: number
  likes: number
  updatedAt: string | null
}
export interface GgufFile {
  repo: string
  path: string
  size: number
  sha256: string | null
  quant: string | null
  shardIndex: number | null
  shardCount: number | null
}
export interface GgufMeta {
  arch: string | null
  blockCount: number | null
  embeddingLength: number | null
  headCount: number | null
  headCountKv: number | null
  keyLength: number | null
  valueLength: number | null
  contextLength: number | null
  expertCount: number | null
}
export type FitLevel = 'green' | 'yellow' | 'red'
export interface MemoryEstimate {
  weightsMB: number
  kvMB: number
  overheadMB: number
  totalMB: number
  level: FitLevel
  note: string
}
export interface DownloadProgress {
  id: string
  label: string
  received: number
  total: number | null
  done: boolean
  error: string | null
}
export interface LocalModel {
  path: string
  name: string
  size: number
}
export interface ComponentsApi {
  status(): Promise<ComponentStatus[]>
  logs(id: ComponentId): Promise<string[]>
  start(id: ComponentId, profileId?: string): Promise<ComponentStatus>
  stop(id: ComponentId, opts?: { force?: boolean }): Promise<ComponentStatus>
  router: { install(): Promise<void>; update(): Promise<void> }
  llama: {
    releases(): Promise<LlamaRelease[]>
    install(backend: LlamaBackend): Promise<void>
    profiles(): Promise<LlamaProfile[]>
    saveProfile(p: LlamaProfile): Promise<LlamaProfile>
    deleteProfile(id: string): Promise<void>
  }
  models: {
    dir(): Promise<string>
    setDir(dir: string): Promise<void>
    local(): Promise<LocalModel[]>
    search(q: string): Promise<GgufRepo[]>
    files(repo: string): Promise<GgufFile[]>
    estimate(
      file: GgufFile,
      ctx: number,
      cacheType: LlamaProfile['cacheType']
    ): Promise<MemoryEstimate>
    download(file: GgufFile): Promise<void>
    remove(path: string): Promise<void>
  }
  hardware(): Promise<HardwareInfo>
  cancelDownload(id: string): Promise<void>
  onStatus(cb: (s: ComponentStatus) => void): () => void
  onLog(cb: (e: { id: ComponentId; line: string }) => void): () => void
  onProgress(cb: (p: DownloadProgress) => void): () => void
}
export const COMPONENT_CHANNELS = {
  invoke: 'components:invoke',
  status: 'components:status',
  log: 'components:log',
  progress: 'components:progress'
} as const

/** Nomes de método aceitos pelo canal `components:invoke` (espelham `ComponentsApi`, sem os `on*`). */
export const COMPONENT_METHODS = [
  'status',
  'logs',
  'start',
  'stop',
  'router.install',
  'router.update',
  'llama.releases',
  'llama.install',
  'llama.profiles',
  'llama.saveProfile',
  'llama.deleteProfile',
  'models.dir',
  'models.setDir',
  'models.local',
  'models.search',
  'models.files',
  'models.estimate',
  'models.download',
  'models.remove',
  'hardware',
  'cancelDownload'
] as const
export type ComponentMethod = (typeof COMPONENT_METHODS)[number]
