import { app, ipcMain, type BrowserWindow } from 'electron'
import { COMPONENT_METHODS } from '../../shared/components'
import { registerComponentsIpc, type ComponentHandlers, type ComponentsIpc } from './ipc'
import { createComponentsContext, registerCore, type ComponentsContext } from './context'
import { registerModels } from './models'
import { registerRouter } from './router'
import { registerLlama } from './llama'

export type { ComponentsContext } from './context'

let bridge: ComponentsIpc | null = null
let ctx: ComponentsContext | null = null

/** Handler padrão para métodos que nenhum módulo registrou ainda. */
function notImplemented(method: string): () => never {
  return () => {
    throw new Error(`components: "${method}" ainda não implementado`)
  }
}

function buildHandlers(c: ComponentsContext): ComponentHandlers {
  const handlers: ComponentHandlers = {}
  for (const m of COMPONENT_METHODS) handlers[m] = notImplemented(m)
  // Um `registerXxx(c, handlers)` por módulo (tasks 4.1–4.4):
  registerCore(c, handlers) // hardware, cancelDownload, status/logs/start/stop (por id)
  registerModels(c, handlers) // models.*
  registerRouter(c, handlers) // router.*, start/stop/status do '9router'
  registerLlama(c, handlers) // llama.*, start/stop/status do 'llama'
  return handlers
}

/** Liga o dispatcher de componentes à janela. Pode ser chamado de novo se a janela for recriada. */
export function initComponents(win: BrowserWindow): void {
  if (bridge) {
    bridge.setWindow(win)
    return
  }
  // Emissores delegam ao bridge (criado logo abaixo, depois dos handlers).
  ctx = createComponentsContext({
    userData: app.getPath('userData'),
    emitStatus: (s) => bridge?.emitStatus(s),
    emitLog: (e) => bridge?.emitLog(e),
    emitProgress: (p) => bridge?.emitProgress(p)
  })
  bridge = registerComponentsIpc(buildHandlers(ctx), win, ipcMain)
}

/** before-quit: cancela downloads e para só os processos gerenciados. */
export async function stopComponents(): Promise<void> {
  if (!ctx) return
  for (const c of ctx.downloads.values()) c.abort()
  await ctx.supervisor.stopAll()
}
