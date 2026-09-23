import type {
  FitLevel,
  GgufFile,
  GgufMeta,
  HardwareInfo,
  LlamaProfile,
  MemoryEstimate
} from '../../shared/components'

const MB = 1 << 20
export const OVERHEAD_MB = 600
/** Bytes por elemento do cache KV. */
export const CACHE_BYTES: Record<LlamaProfile['cacheType'], number> = {
  f16: 2,
  q8_0: 1.0625,
  q4_0: 0.5625
}
/** RAM reservada para o sistema/app antes de contar offload. */
const RAM_RESERVE_MB = 8192

function kvMBFor(meta: GgufMeta, ctx: number, bytes: number): number | null {
  const { blockCount, embeddingLength, headCount } = meta
  if (!blockCount) return null
  const headCountKv = meta.headCountKv ?? headCount
  const keyLength =
    meta.keyLength ?? (embeddingLength && headCount ? embeddingLength / headCount : null)
  if (!headCountKv || !keyLength) return null
  const valueLength = meta.valueLength ?? keyLength
  return (blockCount * ctx * headCountKv * (keyLength + valueLength) * bytes) / MB
}

const round = (n: number): number => Math.round(n)

/**
 * Estimativa de memória para rodar `file` com `ctx` tokens de contexto.
 * green: cabe em 90% da VRAM · yellow: cabe com offload para a RAM livre · red: não cabe.
 * `moeOffload`: o perfil já usa `--n-cpu-moe` (a nota não recomenda de novo).
 */
export function estimateMemory(
  file: Pick<GgufFile, 'size'>,
  meta: GgufMeta | null,
  ctx: number,
  cacheType: LlamaProfile['cacheType'],
  hw: HardwareInfo,
  moeOffload = false
): MemoryEstimate {
  const weightsMB = file.size / MB
  const kv = meta ? kvMBFor(meta, ctx, CACHE_BYTES[cacheType] ?? CACHE_BYTES.f16) : null
  let kvMB: number
  let overheadMB: number
  let approx = false
  if (kv === null) {
    // Sem metadados: só pesos + 20%.
    approx = true
    kvMB = 0
    overheadMB = weightsMB * 0.2
  } else {
    kvMB = kv
    overheadMB = OVERHEAD_MB
  }
  const totalMB = weightsMB + kvMB + overheadMB
  const vramBudget = 0.9 * (hw.vramMB ?? 0)
  const ramBudget = Math.max(0, hw.ramMB - RAM_RESERVE_MB)
  const moe = (meta?.expertCount ?? 0) > 0

  let level: FitLevel
  let note: string
  if (vramBudget > 0 && totalMB <= vramBudget) {
    level = 'green'
    note = 'Cabe inteiro na VRAM (-ngl 99).'
  } else if (totalMB <= vramBudget + ramBudget) {
    level = 'yellow'
    const where = vramBudget > 0 ? 'Não cabe só na VRAM' : 'Sem GPU detectada'
    if (moe) {
      note = moeOffload
        ? `${where}; o --n-cpu-moe do perfil manda experts para a RAM (mais lento).`
        : `${where}: use --n-cpu-moe para deixar os experts na RAM (modelo MoE).`
    } else {
      note = `${where}: use -ngl parcial (algumas camadas na RAM, mais lento).`
    }
  } else {
    level = 'red'
    note = 'Não cabe na VRAM + RAM livre: escolha uma quantização menor ou reduza o contexto.'
  }
  if (approx) note = `Estimativa aproximada (sem metadados do GGUF). ${note}`
  return {
    weightsMB: round(weightsMB),
    kvMB: round(kvMB),
    overheadMB: round(overheadMB),
    totalMB: round(totalMB),
    level,
    note
  }
}
