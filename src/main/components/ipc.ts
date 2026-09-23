import type { ComponentId, ComponentStatus, DownloadProgress } from '../../shared/components'
import { COMPONENT_CHANNELS } from '../../shared/components'

// Sem import de valor de `electron`: o ipcMain real é injetado por index.ts e o teste injeta um fake.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentHandler = (...a: any[]) => unknown
export type ComponentHandlers = Record<string, ComponentHandler>

/** Subconjunto de `ipcMain` usado aqui. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

/** Subconjunto de `BrowserWindow` usado para emitir eventos. */
export interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export interface ComponentsIpc {
  emitStatus(s: ComponentStatus): void
  emitLog(e: { id: ComponentId; line: string }): void
  emitProgress(p: DownloadProgress): void
  /** Troca a janela alvo dos eventos (janela recriada). */
  setWindow(win: WindowLike | null): void
  dispose(): void
}

/** Chama o handler `method`; método desconhecido ou nome inválido → erro claro. */
export async function dispatchComponents(
  handlers: ComponentHandlers,
  method: unknown,
  args: unknown[]
): Promise<unknown> {
  if (typeof method !== 'string' || !method) {
    throw new Error(`components: nome de método inválido (${String(method)})`)
  }
  const h = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined
  if (typeof h !== 'function') throw new Error(`components: método desconhecido "${method}"`)
  return await h(...args)
}

export function registerComponentsIpc(
  handlers: ComponentHandlers,
  win: WindowLike | null,
  ipc: IpcMainLike
): ComponentsIpc {
  let target = win
  ipc.handle(COMPONENT_CHANNELS.invoke, (_e, method, ...args) =>
    dispatchComponents(handlers, method, args)
  )
  const send = (channel: string, payload: unknown): void => {
    if (target && !target.isDestroyed()) target.webContents.send(channel, payload)
  }
  return {
    emitStatus: (s) => send(COMPONENT_CHANNELS.status, s),
    emitLog: (e) => send(COMPONENT_CHANNELS.log, e),
    emitProgress: (p) => send(COMPONENT_CHANNELS.progress, p),
    setWindow: (w) => {
      target = w
    },
    dispose: () => ipc.removeHandler(COMPONENT_CHANNELS.invoke)
  }
}
