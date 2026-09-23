import type {
  ComponentStatus,
  DownloadProgress,
  FitLevel,
  GgufFile,
  HardwareInfo,
  LlamaBackend,
  LlamaProfile,
  LlamaRelease
} from '@shared/components'

// Lógica pura da tela Componentes (sem React, sem window): testada em tests/renderer/componentsFormat.test.ts.

/** Máximo de linhas de log guardadas por componente (igual ao ring buffer do main). */
export const LOG_LIMIT = 2000

/** Dashboard do 9router (cadastro de providers e combos é manual, lá). */
export const ROUTER_DASHBOARD = 'http://localhost:20128/dashboard'

/** `512` → `512 B`, `1536` → `1.5 KB`, `8.6e9` → `8.0 GB` (base 1024). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Tamanho em MiB (como vem de estimativas/hardware) → texto legível. */
export function formatMB(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '?'
  return formatBytes(mb * 1024 * 1024)
}

/** Fração 0–100 de um download; `null` quando o total é desconhecido. */
export function progressPct(p: Pick<DownloadProgress, 'received' | 'total'>): number | null {
  if (!p.total || p.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((p.received / p.total) * 100)))
}

/** Porcentagem agregada dos downloads ativos (só os de total conhecido). */
export function aggregatePct(list: DownloadProgress[]): number | null {
  const active = list.filter((p) => !p.done && !p.error && p.total && p.total > 0)
  if (!active.length) return null
  const total = active.reduce((a, p) => a + (p.total ?? 0), 0)
  const received = active.reduce((a, p) => a + p.received, 0)
  return progressPct({ received, total })
}

// ---------------------------------------------------------------- quantizações

/**
 * Ordem de exibição das quantizações: da mais leve para a mais pesada.
 * Desconhecidas vão para o fim, em ordem alfabética.
 */
const QUANT_ORDER = [
  'IQ1_S',
  'IQ1_M',
  'IQ2_XXS',
  'IQ2_XS',
  'IQ2_S',
  'IQ2_M',
  'Q2_K_S',
  'Q2_K',
  'Q2_K_L',
  'IQ3_XXS',
  'IQ3_XS',
  'IQ3_S',
  'IQ3_M',
  'Q3_K_S',
  'Q3_K_M',
  'Q3_K_L',
  'Q3_K_XL',
  'IQ4_XS',
  'IQ4_NL',
  'Q4_0',
  'Q4_1',
  'Q4_K_S',
  'Q4_K_M',
  'Q4_K_L',
  'Q4_K_XL',
  'Q5_0',
  'Q5_1',
  'Q5_K_S',
  'Q5_K_M',
  'Q5_K_L',
  'Q5_K_XL',
  'Q6_K',
  'Q6_K_L',
  'Q6_K_XL',
  'Q8_0',
  'Q8_K_XL',
  'BF16',
  'F16',
  'F32'
]

export function quantRank(q: string | null): number {
  if (!q) return QUANT_ORDER.length + 1
  const i = QUANT_ORDER.indexOf(q.toUpperCase())
  return i === -1 ? QUANT_ORDER.length : i
}

/** Ordena arquivos GGUF por quantização (leve → pesada), depois tamanho, depois caminho. */
export function sortGgufFiles(files: GgufFile[]): GgufFile[] {
  return [...files].sort(
    (a, b) =>
      quantRank(a.quant) - quantRank(b.quant) ||
      (a.quant ?? '').localeCompare(b.quant ?? '') ||
      a.size - b.size ||
      a.path.localeCompare(b.path)
  )
}

/** Nome do arquivo sem as pastas do repo. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

// ---------------------------------------------------------------- níveis e status

export function levelLabel(l: FitLevel): string {
  return l === 'green' ? 'cabe na VRAM' : l === 'yellow' ? 'precisa de offload' : 'não cabe'
}

/** Classes Tailwind para o badge de nível. */
export function levelClass(l: FitLevel): string {
  if (l === 'green')
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  if (l === 'yellow')
    return 'border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400'
  return 'border-destructive/40 bg-destructive/15 text-destructive'
}

export type Dot = 'green' | 'gray' | 'red'

/** Ponto do indicador: rodando e saudável → verde; rodando sem responder → vermelho; senão cinza. */
export function statusDot(s: ComponentStatus | undefined): Dot {
  if (!s || !s.running) return 'gray'
  return s.healthy ? 'green' : 'red'
}

export function dotClass(d: Dot): string {
  return d === 'green'
    ? 'bg-emerald-500'
    : d === 'red'
      ? 'bg-destructive'
      : 'bg-muted-foreground/50'
}

export function statusText(s: ComponentStatus | undefined): string {
  if (!s) return 'status desconhecido'
  if (!s.installed) return 'não instalado'
  if (!s.running) return 'parado'
  const who = s.ownership === 'external' ? 'externo' : 'gerenciado'
  return s.healthy ? `rodando (${who})` : `sem resposta (${who})`
}

export function ownershipLabel(o: ComponentStatus['ownership']): string {
  return o === 'managed' ? 'gerenciado' : o === 'external' ? 'externo' : 'parado'
}

/** Há versão mais nova? Compara números separados por ponto (0.5.55 < 0.5.86). */
export function isOutdated(version: string | null, latest: string | null): boolean {
  if (!version || !latest) return false
  const a = version.replace(/^v/, '').split(/[.-]/).map(Number)
  const b = latest.replace(/^v/, '').split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return version !== latest
    if (x !== y) return x < y
  }
  return false
}

// ---------------------------------------------------------------- erros

/** Tira o prefixo que o Electron põe em erros de `ipcRenderer.invoke` e o prefixo `components:`. */
export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error:\s*)+/, '')
    .replace(/^components:\s*/, '')
}

/** Handler do main ainda não registrado (tasks em paralelo): a UI mostra aviso discreto. */
export function isNotImplemented(e: unknown): boolean {
  return /ainda não implementado/.test(cleanError(e))
}

// ---------------------------------------------------------------- llama.cpp

export const BACKEND_LABEL: Record<LlamaBackend, string> = {
  'cuda-12.4': 'CUDA 12.4',
  'cuda-13.4': 'CUDA 13.4',
  vulkan: 'Vulkan',
  cpu: 'CPU'
}

/** Backend sugerido: NVIDIA → CUDA 12.4 (compatível com Turing e drivers atuais); outra GPU → Vulkan; sem GPU → CPU. */
export function recommendedBackend(hw: HardwareInfo | null): LlamaBackend {
  if (!hw || !hw.gpuName) return hw ? 'cpu' : 'cuda-12.4'
  return /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(hw.gpuName) ? 'cuda-12.4' : 'vulkan'
}

/** Release mais recente de cada backend (a lista do main já vem da mais nova para a mais velha). */
export function latestByBackend(
  releases: LlamaRelease[]
): Partial<Record<LlamaBackend, LlamaRelease>> {
  const out: Partial<Record<LlamaBackend, LlamaRelease>> = {}
  for (const r of releases) {
    const cur = out[r.backend]
    if (!cur || tagNumber(r.tag) > tagNumber(cur.tag)) out[r.backend] = r
  }
  return out
}

function tagNumber(tag: string): number {
  const m = /(\d+)/.exec(tag)
  return m ? Number(m[1]) : -1
}

export function releaseSize(r: LlamaRelease): number {
  return r.assets.reduce((a, x) => a + (x.size || 0), 0)
}

/**
 * Divide args livres por espaço respeitando aspas simples/duplas (`--a "b c"` → `['--a', 'b c']`).
 * Mesma regra do `buildArgs` do main; aqui serve para pré-visualizar o comando.
 */
export function parseArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

/** Pré-visualização da linha de comando do llama-server para um perfil. */
export function previewArgs(p: LlamaProfile): string[] {
  const a = ['-m', p.modelPath || '<modelo>', '-c', String(p.ctx), '-ngl', String(p.ngl)]
  a.push('--port', String(p.port), '--host', '127.0.0.1')
  if (p.flashAttn) a.push('-fa', 'on')
  a.push('--cache-type-k', p.cacheType, '--cache-type-v', p.cacheType)
  if (p.nCpuMoe !== null) a.push('--n-cpu-moe', String(p.nCpuMoe))
  return [...a, ...parseArgs(p.extraArgs)]
}

export function validPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1024 && n <= 65535
}

/** Endpoint OpenAI-compatible que o usuário cadastra no 9router. */
export function llamaEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/** Nome do modelo sugerido para o cadastro no 9router: arquivo sem `.gguf` nem sufixo de shard. */
export function modelIdFromPath(path: string): string {
  return baseName(path)
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
}

export function newProfile(id: string): LlamaProfile {
  return {
    id,
    name: 'Novo perfil',
    modelPath: '',
    ctx: 32768,
    nCpuMoe: null,
    ngl: 99,
    flashAttn: true,
    cacheType: 'q8_0',
    port: 8080,
    extraArgs: ''
  }
}

/** Anexa linhas ao log mantendo só as últimas `limit`. */
export function appendLog(prev: string[], lines: string[], limit = LOG_LIMIT): string[] {
  const next = prev.concat(lines)
  return next.length > limit ? next.slice(next.length - limit) : next
}

// ---------------------------------------------------------------- modelos

/** Mesmo id que o main usa para o progresso de download de um GGUF (`hf:<repo>/<path>`). */
export function hfDownloadId(file: Pick<GgufFile, 'repo' | 'path'>): string {
  return `hf:${file.repo}/${file.path}`
}

/**
 * Reconstrói o `GgufFile` de um modelo local baixado pelo app (`<dir>/<dono>__<repo>/<arquivo>`),
 * para pedir a estimativa de memória. Fora desse layout → `null` (sem estimativa).
 */
export function localToGgufFile(local: { path: string; size: number }): GgufFile | null {
  const parts = local.path.split(/[\\/]/).filter(Boolean)
  if (parts.length < 2) return null
  const file = parts[parts.length - 1]
  const folder = parts[parts.length - 2]
  const i = folder.indexOf('__')
  if (i <= 0 || i === folder.length - 2) return null
  const repo = `${folder.slice(0, i)}/${folder.slice(i + 2)}`
  const shard = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(file)
  return {
    repo,
    path: file,
    size: local.size,
    sha256: null,
    quant: quantFromName(file),
    shardIndex: shard ? Number(shard[1]) : null,
    shardCount: shard ? Number(shard[2]) : null
  }
}

/** Quantização a partir do nome do arquivo (mesma regex do main). */
export function quantFromName(name: string): string | null {
  const m = /(IQ\d_[A-Z]+|Q\d(_K)?(_[SML])?|Q\d_\d|F16|BF16|F32)/i.exec(name)
  return m ? m[1].toUpperCase() : null
}
