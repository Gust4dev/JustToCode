import { describe, it, expect } from 'vitest'
import type { ComponentStatus, GgufFile, LlamaRelease } from '../../src/shared/components'
import {
  aggregatePct,
  appendLog,
  cleanError,
  formatBytes,
  formatMB,
  hfDownloadId,
  isNotImplemented,
  isOutdated,
  latestByBackend,
  levelClass,
  levelLabel,
  llamaEndpoint,
  localToGgufFile,
  modelIdFromPath,
  newProfile,
  parseArgs,
  previewArgs,
  progressPct,
  quantFromName,
  quantRank,
  recommendedBackend,
  releaseSize,
  sortGgufFiles,
  statusDot,
  statusText,
  validPort
} from '../../src/renderer/src/features/components/format'
import { applyProgressTo } from '../../src/renderer/src/features/components/componentsStore'

const status = (p: Partial<ComponentStatus>): ComponentStatus => ({
  id: '9router',
  installed: true,
  version: '0.5.55',
  latestVersion: '0.5.86',
  running: false,
  ownership: 'stopped',
  pid: null,
  url: null,
  healthy: false,
  message: null,
  ...p
})

const gguf = (path: string, quant: string | null, size = 1): GgufFile => ({
  repo: 'o/r',
  path,
  size,
  sha256: null,
  quant,
  shardIndex: null,
  shardCount: null
})

describe('tamanhos', () => {
  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(254 * 2 ** 20)).toBe('254 MB')
    expect(formatBytes(8 * 2 ** 30)).toBe('8.0 GB')
    expect(formatBytes(-1)).toBe('?')
    expect(formatBytes(null)).toBe('?')
  })
  it('formatMB', () => {
    expect(formatMB(8192)).toBe('8.0 GB')
    expect(formatMB(600)).toBe('600 MB')
    expect(formatMB(null)).toBe('?')
  })
  it('progresso individual e agregado', () => {
    expect(progressPct({ received: 50, total: 200 })).toBe(25)
    expect(progressPct({ received: 50, total: null })).toBeNull()
    const base = { label: 'x', done: false, error: null }
    expect(
      aggregatePct([
        { ...base, id: 'a', received: 100, total: 100 },
        { ...base, id: 'b', received: 0, total: 300 },
        { ...base, id: 'c', received: 5, total: 10, error: 'falhou' }
      ])
    ).toBe(25)
    expect(aggregatePct([])).toBeNull()
  })
})

describe('quantizações', () => {
  it('ordena da mais leve para a mais pesada; desconhecidas e null no fim', () => {
    const files = [
      gguf('m-Q8_0.gguf', 'Q8_0'),
      gguf('m-F16.gguf', 'F16'),
      gguf('m-XYZ.gguf', 'XYZ'),
      gguf('m.gguf', null),
      gguf('m-Q4_K_M.gguf', 'Q4_K_M'),
      gguf('m-IQ2_XS.gguf', 'IQ2_XS'),
      gguf('m-Q4_K_S.gguf', 'Q4_K_S')
    ]
    expect(sortGgufFiles(files).map((f) => f.quant)).toEqual([
      'IQ2_XS',
      'Q4_K_S',
      'Q4_K_M',
      'Q8_0',
      'F16',
      'XYZ',
      null
    ])
    expect(files[0].quant).toBe('Q8_0') // não muta a entrada
  })
  it('quantRank ignora caixa', () => {
    expect(quantRank('q4_k_m')).toBe(quantRank('Q4_K_M'))
  })
  it('quantFromName', () => {
    expect(quantFromName('Qwen3-30B-A3B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantFromName('model-iq3_xxs.gguf')).toBe('IQ3_XXS')
    expect(quantFromName('model.gguf')).toBeNull()
  })
})

describe('níveis e status', () => {
  it('rótulo e cor por nível', () => {
    expect(levelLabel('green')).toMatch(/cabe/)
    expect(levelClass('green')).toMatch(/emerald/)
    expect(levelClass('yellow')).toMatch(/amber/)
    expect(levelClass('red')).toMatch(/destructive/)
  })
  it('ponto do indicador', () => {
    expect(statusDot(undefined)).toBe('gray')
    expect(statusDot(status({ running: false }))).toBe('gray')
    expect(statusDot(status({ running: true, healthy: true }))).toBe('green')
    expect(statusDot(status({ running: true, healthy: false }))).toBe('red')
  })
  it('texto de status', () => {
    expect(statusText(undefined)).toBe('status desconhecido')
    expect(statusText(status({ installed: false }))).toBe('não instalado')
    expect(statusText(status({ running: true, healthy: true, ownership: 'external' }))).toBe(
      'rodando (externo)'
    )
  })
  it('isOutdated compara versões numericamente', () => {
    expect(isOutdated('0.5.55', '0.5.86')).toBe(true)
    expect(isOutdated('0.5.9', '0.5.10')).toBe(true)
    expect(isOutdated('0.5.86', '0.5.86')).toBe(false)
    expect(isOutdated('0.6.0', '0.5.86')).toBe(false)
    expect(isOutdated(null, '0.5.86')).toBe(false)
  })
})

describe('erros', () => {
  it('limpa prefixos do IPC', () => {
    const e = new Error(
      `Error invoking remote method 'components:invoke': Error: components: "llama.releases" ainda não implementado`
    )
    expect(cleanError(e)).toBe('"llama.releases" ainda não implementado')
    expect(isNotImplemented(e)).toBe(true)
    expect(isNotImplemented(new Error('STOP_FIRST'))).toBe(false)
  })
})

describe('llama.cpp', () => {
  it('backend recomendado', () => {
    expect(
      recommendedBackend({
        gpuName: 'NVIDIA GeForce RTX 2070 SUPER',
        vramMB: 8192,
        driver: '610',
        ramMB: 32768
      })
    ).toBe('cuda-12.4')
    expect(recommendedBackend({ gpuName: null, vramMB: null, driver: null, ramMB: 8000 })).toBe(
      'cpu'
    )
    expect(
      recommendedBackend({ gpuName: 'AMD Radeon', vramMB: 8000, driver: null, ramMB: 8000 })
    ).toBe('vulkan')
  })
  it('release mais recente por backend e tamanho somado', () => {
    const rel = (tag: string, backend: LlamaRelease['backend'], sizes: number[]): LlamaRelease => ({
      tag,
      backend,
      assets: sizes.map((size, i) => ({ name: `a${i}`, url: 'u', size }))
    })
    const latest = latestByBackend([
      rel('b6500', 'cuda-12.4', [1]),
      rel('b6600', 'cuda-12.4', [254, 391]),
      rel('b6550', 'cpu', [10])
    ])
    expect(latest['cuda-12.4']?.tag).toBe('b6600')
    expect(latest.cpu?.tag).toBe('b6550')
    expect(latest.vulkan).toBeUndefined()
    expect(releaseSize(latest['cuda-12.4']!)).toBe(645)
  })
  it('parseArgs respeita aspas', () => {
    expect(parseArgs('')).toEqual([])
    expect(parseArgs('  --jinja   --alias "meu modelo" --x \'a b\'  ')).toEqual([
      '--jinja',
      '--alias',
      'meu modelo',
      '--x',
      'a b'
    ])
    expect(parseArgs('--empty ""')).toEqual(['--empty', ''])
  })
  it('previewArgs monta a linha do llama-server', () => {
    const p = { ...newProfile('p1'), modelPath: 'C:\\m\\x.gguf', nCpuMoe: 20, extraArgs: '--jinja' }
    expect(previewArgs(p)).toEqual([
      '-m',
      'C:\\m\\x.gguf',
      '-c',
      '32768',
      '-ngl',
      '99',
      '--port',
      '8080',
      '--host',
      '127.0.0.1',
      '-fa',
      'on',
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--n-cpu-moe',
      '20',
      '--jinja'
    ])
    const off = previewArgs({ ...p, flashAttn: false, nCpuMoe: null, extraArgs: '' })
    expect(off).not.toContain('-fa')
    expect(off).not.toContain('--n-cpu-moe')
  })
  it('porta, endpoint e nome do modelo', () => {
    expect(validPort(8080)).toBe(true)
    expect(validPort(80)).toBe(false)
    expect(validPort(70000)).toBe(false)
    expect(validPort(8080.5)).toBe(false)
    expect(llamaEndpoint(8080)).toBe('http://127.0.0.1:8080/v1')
    expect(modelIdFromPath('C:\\models\\o__r\\Qwen3-Q4_K_M-00001-of-00003.gguf')).toBe(
      'Qwen3-Q4_K_M'
    )
  })
})

describe('modelos e downloads', () => {
  it('hfDownloadId igual ao do main', () => {
    expect(hfDownloadId({ repo: 'o/r', path: 'a/m.gguf' })).toBe('hf:o/r/a/m.gguf')
  })
  it('localToGgufFile reconstrói repo a partir da pasta', () => {
    expect(
      localToGgufFile({ path: 'C:\\data\\models\\unsloth__Qwen3-GGUF\\q-Q4_K_M.gguf', size: 9 })
    ).toMatchObject({ repo: 'unsloth/Qwen3-GGUF', path: 'q-Q4_K_M.gguf', size: 9, quant: 'Q4_K_M' })
    expect(localToGgufFile({ path: '/m/o__r/x-00001-of-00002.gguf', size: 1 })).toMatchObject({
      shardIndex: 1,
      shardCount: 2
    })
    expect(localToGgufFile({ path: 'C:\\solto\\x.gguf', size: 1 })).toBeNull()
  })
  it('applyProgressTo remove concluídos sem erro e mantém falhas', () => {
    const p = { id: 'a', label: 'a', received: 1, total: 2, done: false, error: null }
    let m = applyProgressTo({}, p)
    expect(m.a.received).toBe(1)
    m = applyProgressTo(m, { ...p, done: true, received: 2 })
    expect(m.a).toBeUndefined()
    m = applyProgressTo(m, { ...p, done: true, error: 'hash' })
    expect(m.a.error).toBe('hash')
  })
  it('appendLog mantém só as últimas N linhas', () => {
    expect(appendLog(['a', 'b'], ['c'], 2)).toEqual(['b', 'c'])
    const big = appendLog(
      [],
      Array.from({ length: 2500 }, (_, i) => String(i))
    )
    expect(big).toHaveLength(2000)
    expect(big[0]).toBe('500')
  })
})
