import { describe, it, expect } from 'vitest'
import { estimateMemory } from '../../src/main/components/estimate'
import type { GgufMeta, HardwareInfo } from '../../src/shared/components'

// Máquina do usuário: RTX 2070 SUPER 8 GB, 32 GB RAM.
const HW: HardwareInfo = { gpuName: 'RTX 2070 SUPER', vramMB: 8192, driver: '610', ramMB: 32768 }
const GB = 1024 ** 3

const QWEN3_30B_A3B: GgufMeta = {
  arch: 'qwen3moe',
  blockCount: 48,
  embeddingLength: 2048,
  headCount: 32,
  headCountKv: 4,
  keyLength: 128,
  valueLength: 128,
  contextLength: 40960,
  expertCount: 128
}
const QWEN25_7B: GgufMeta = {
  arch: 'qwen2',
  blockCount: 28,
  embeddingLength: 3584,
  headCount: 28,
  headCountKv: 4,
  keyLength: null,
  valueLength: null,
  contextLength: 32768,
  expertCount: null
}
const LLAMA_70B: GgufMeta = {
  arch: 'llama',
  blockCount: 80,
  embeddingLength: 8192,
  headCount: 64,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
  contextLength: 131072,
  expertCount: null
}

describe('estimateMemory', () => {
  it('30B-A3B Q4_K_M, ctx 32k, q8_0 → yellow recomendando --n-cpu-moe', () => {
    const e = estimateMemory({ size: 18.6 * GB }, QWEN3_30B_A3B, 32768, 'q8_0', HW)
    // kv = 48 × 32768 × 4 × (128+128) × 1.0625 B = 1632 MB
    expect(e.kvMB).toBe(1632)
    expect(e.overheadMB).toBe(600)
    expect(e.level).toBe('yellow')
    expect(e.note).toMatch(/--n-cpu-moe/)
    expect(e.totalMB).toBe(e.weightsMB + e.kvMB + e.overheadMB)
  })
  it('com moeOffload a nota diz que o perfil já faz offload', () => {
    const e = estimateMemory({ size: 18.6 * GB }, QWEN3_30B_A3B, 32768, 'q8_0', HW, true)
    expect(e.level).toBe('yellow')
    expect(e.note).toMatch(/do perfil/)
  })
  it('7B Q4_K_M, ctx 8k → green (keyLength derivado de embedding/head)', () => {
    const e = estimateMemory({ size: 4.68 * GB }, QWEN25_7B, 8192, 'q8_0', HW)
    // keyLength = 3584/28 = 128 → kv = 28 × 8192 × 4 × 256 × 1.0625 B = 238 MB
    expect(e.kvMB).toBe(238)
    expect(e.level).toBe('green')
  })
  it('denso que não cabe na VRAM → yellow com -ngl parcial', () => {
    const e = estimateMemory({ size: 8.5 * GB }, QWEN25_7B, 32768, 'f16', HW)
    expect(e.level).toBe('yellow')
    expect(e.note).toMatch(/-ngl parcial/)
  })
  it('70B Q4 com 128k de contexto → red', () => {
    const e = estimateMemory({ size: 42.5 * GB }, LLAMA_70B, 131072, 'f16', HW)
    expect(e.level).toBe('red')
  })
  it('tipos de cache menores reduzem o KV', () => {
    const f16 = estimateMemory({ size: GB }, QWEN3_30B_A3B, 32768, 'f16', HW).kvMB
    const q8 = estimateMemory({ size: GB }, QWEN3_30B_A3B, 32768, 'q8_0', HW).kvMB
    const q4 = estimateMemory({ size: GB }, QWEN3_30B_A3B, 32768, 'q4_0', HW).kvMB
    expect(f16).toBeGreaterThan(q8)
    expect(q8).toBeGreaterThan(q4)
  })
  it('sem meta → pesos + 20% e nota de estimativa aproximada', () => {
    const e = estimateMemory({ size: 4 * GB }, null, 32768, 'q8_0', HW)
    expect(e.kvMB).toBe(0)
    expect(e.totalMB).toBe(Math.round(4096 * 1.2))
    expect(e.level).toBe('green')
    expect(e.note).toMatch(/aproximada/)
  })
  it('sem GPU: só a RAM conta (nunca green)', () => {
    const e = estimateMemory({ size: 4 * GB }, QWEN25_7B, 8192, 'q8_0', {
      ...HW,
      vramMB: null,
      gpuName: null
    })
    expect(e.level).toBe('yellow')
    expect(e.note).toMatch(/Sem GPU/)
  })
})
