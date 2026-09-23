import { describe, it, expect, vi } from 'vitest'
import {
  registerComponentsIpc,
  dispatchComponents,
  type IpcMainLike,
  type WindowLike
} from '../../src/main/components/ipc'
import { COMPONENT_CHANNELS, type ComponentStatus } from '../../src/shared/components'

type Listener = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): IpcMainLike & { handlers: Map<string, Listener> } {
  const handlers = new Map<string, Listener>()
  return {
    handlers,
    handle: (ch, l) => {
      if (handlers.has(ch)) throw new Error(`duplicado: ${ch}`)
      handlers.set(ch, l)
    },
    removeHandler: (ch) => {
      handlers.delete(ch)
    }
  }
}

function fakeWin(): WindowLike & { sent: [string, unknown][]; destroyed: boolean } {
  const w = {
    sent: [] as [string, unknown][],
    destroyed: false,
    isDestroyed: () => w.destroyed,
    webContents: { send: (ch: string, p: unknown) => void w.sent.push([ch, p]) }
  }
  return w
}

const status: ComponentStatus = {
  id: 'llama',
  installed: true,
  version: 'b1',
  latestVersion: null,
  running: false,
  ownership: 'stopped',
  pid: null,
  url: null,
  healthy: false,
  message: null
}

describe('registerComponentsIpc', () => {
  it('registra um único canal invoke e despacha por nome de método com args', async () => {
    const ipc = fakeIpc()
    const search = vi.fn(async (q: string) => [{ id: q, downloads: 1, likes: 2, updatedAt: null }])
    registerComponentsIpc({ 'models.search': search, status: () => [status] }, fakeWin(), ipc)

    expect([...ipc.handlers.keys()]).toEqual([COMPONENT_CHANNELS.invoke])
    const invoke = ipc.handlers.get(COMPONENT_CHANNELS.invoke)!
    await expect(invoke({}, 'models.search', 'qwen')).resolves.toEqual([
      { id: 'qwen', downloads: 1, likes: 2, updatedAt: null }
    ])
    expect(search).toHaveBeenCalledWith('qwen')
    await expect(invoke({}, 'status')).resolves.toEqual([status])
  })

  it('método desconhecido ou inválido rejeita com erro claro', async () => {
    const ipc = fakeIpc()
    registerComponentsIpc({}, fakeWin(), ipc)
    const invoke = ipc.handlers.get(COMPONENT_CHANNELS.invoke)!
    await expect(invoke({}, 'router.nope')).rejects.toThrow(/método desconhecido "router.nope"/)
    await expect(invoke({}, 'toString')).rejects.toThrow(/método desconhecido/)
    await expect(invoke({}, 42)).rejects.toThrow(/nome de método inválido/)
  })

  it('propaga erro do handler', async () => {
    await expect(
      dispatchComponents(
        {
          'router.install': () => {
            throw new Error('falhou')
          }
        },
        'router.install',
        []
      )
    ).rejects.toThrow('falhou')
  })

  it('emite eventos nos canais certos, ignora janela destruída e troca de janela', () => {
    const ipc = fakeIpc()
    const w1 = fakeWin()
    const bridge = registerComponentsIpc({}, w1, ipc)
    bridge.emitStatus(status)
    bridge.emitLog({ id: '9router', line: 'oi' })
    bridge.emitProgress({ id: 'd', label: 'x', received: 1, total: null, done: false, error: null })
    expect(w1.sent.map(([ch]) => ch)).toEqual([
      COMPONENT_CHANNELS.status,
      COMPONENT_CHANNELS.log,
      COMPONENT_CHANNELS.progress
    ])

    w1.destroyed = true
    bridge.emitStatus(status)
    expect(w1.sent).toHaveLength(3)

    const w2 = fakeWin()
    bridge.setWindow(w2)
    bridge.emitLog({ id: 'llama', line: 'l' })
    expect(w2.sent).toEqual([[COMPONENT_CHANNELS.log, { id: 'llama', line: 'l' }]])
  })

  it('dispose remove o handler', () => {
    const ipc = fakeIpc()
    registerComponentsIpc({}, null, ipc).dispose()
    expect(ipc.handlers.size).toBe(0)
  })
})
