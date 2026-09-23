import {
  utilityProcess,
  MessageChannelMain,
  app,
  type BrowserWindow,
  type UtilityProcess
} from 'electron'
import { join } from 'node:path'
import type { AppConfig } from '@shared/domain'

export interface AgentHostHandle {
  restart(): void
  dispose(): void
  /** Reenvia a config atual ao host (após settings:set). */
  pushConfig(): void
}

export function startAgentHost(win: BrowserWindow, getConfig: () => AppConfig): AgentHostHandle {
  let child: UtilityProcess | null = null
  let disposed = false

  // Um canal novo a cada carga do renderer (inclui Ctrl+R) e a cada respawn do host.
  // Em 'did-finish-load' o webContents ainda pode reportar isLoading() === true,
  // então só o caminho do spawn consulta isLoading (a carga em andamento reenviará a porta).
  const connect = (fromLoad = false): void => {
    if (!child || win.isDestroyed()) return
    if (!fromLoad && win.webContents.isLoading()) return
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ type: 'port' }, [port1])
    win.webContents.postMessage('agent-port', null, [port2])
  }

  const pushConfig = (): void => {
    child?.postMessage({ type: 'config', config: getConfig() })
  }

  const spawn = (): void => {
    const proc = utilityProcess.fork(join(__dirname, 'agent-host.js'), [], {
      serviceName: 'agent-host',
      stdio: 'inherit',
      env: {
        ...process.env,
        JTC_VERSION: app.getVersion(),
        JTC_USER_DATA: app.getPath('userData')
      }
    })
    child = proc
    proc.on('spawn', () => {
      console.log(`[agent-host] iniciado (pid ${proc.pid})`)
      pushConfig()
      connect()
    })
    proc.on('exit', (code) => {
      if (child === proc) child = null
      if (disposed || code === 0) return
      console.warn(`[agent-host] saiu com código ${code}; reiniciando em 1 s`)
      setTimeout(() => {
        if (disposed || win.isDestroyed()) return
        spawn()
        win.webContents.send('agent-host:restarted')
      }, 1000)
    })
  }

  win.webContents.on('did-finish-load', () => connect(true))
  spawn()

  return {
    pushConfig,
    restart(): void {
      child?.kill()
    },
    dispose(): void {
      disposed = true
      child?.kill()
    }
  }
}
