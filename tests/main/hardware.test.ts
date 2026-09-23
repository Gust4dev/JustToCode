import { describe, it, expect } from 'vitest'
import { totalmem } from 'node:os'
import { detectHardware, parseNvidiaSmi } from '../../src/main/components/hardware'
import { createComponentsContext, registerCore } from '../../src/main/components/context'
import type { ComponentHandlers } from '../../src/main/components/ipc'

const RAM = Math.round(totalmem() / (1024 * 1024))

describe('detectHardware', () => {
  it('lê nome, VRAM e driver da saída do nvidia-smi', async () => {
    const calls: [string, string[]][] = []
    const hw = await detectHardware(async (cmd, args) => {
      calls.push([cmd, args])
      return 'NVIDIA GeForce RTX 2070 SUPER, 8192 MiB, 610.47\r\n'
    })
    expect(hw).toEqual({
      gpuName: 'NVIDIA GeForce RTX 2070 SUPER',
      vramMB: 8192,
      driver: '610.47',
      ramMB: RAM
    })
    expect(calls[0][0]).toBe('nvidia-smi')
    expect(calls[0][1]).toContain('--format=csv,noheader')
  })

  it('nvidia-smi ausente → GPU null, RAM preenchida', async () => {
    const hw = await detectHardware(async () => {
      throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })
    })
    expect(hw).toEqual({ gpuName: null, vramMB: null, driver: null, ramMB: RAM })
  })

  it('várias GPUs: usa a primeira; saída vazia → null', () => {
    expect(parseNvidiaSmi('GPU A, 4096 MiB, 1\nGPU B, 8192 MiB, 1\n').gpuName).toBe('GPU A')
    expect(parseNvidiaSmi('')).toEqual({ gpuName: null, vramMB: null, driver: null })
  })

  it('handler "hardware" registrado por registerCore', async () => {
    const ctx = createComponentsContext({
      userData: '.',
      emitStatus: () => {},
      emitLog: () => {},
      emitProgress: () => {}
    })
    const handlers: ComponentHandlers = {}
    registerCore(ctx, handlers, async () => 'X, 1024 MiB, 9')
    expect(await handlers['hardware']()).toMatchObject({ gpuName: 'X', vramMB: 1024 })
  })
})
