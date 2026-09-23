import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { UpdateState } from '../main/updater/state'
import type { AppConfig } from '../shared/domain'
import type { ComponentsApi, COMPONENT_CHANNELS } from '../shared/components'

// Preload roda com sandbox: true — só `electron` (contextBridge/ipcRenderer) está disponível.
// Imports de tipo são apagados no build, então não violam essa regra.

// Repassa a porta do agent-host para o mundo principal (MessagePort não atravessa o contextBridge).
ipcRenderer.on('agent-port', (e) => {
  window.postMessage('agent-port', '*', e.ports)
})

// Literais em vez de importar COMPONENT_CHANNELS (valor): o preload sandboxed só usa `electron`.
// O tipo garante que continuam iguais aos de src/shared/components.ts.
const CH: typeof COMPONENT_CHANNELS = {
  invoke: 'components:invoke',
  status: 'components:status',
  log: 'components:log',
  progress: 'components:progress'
}

const call =
  (method: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: unknown[]): Promise<any> =>
    ipcRenderer.invoke(CH.invoke, method, ...args)

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: IpcRendererEvent, v: T): void => cb(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const components: ComponentsApi = {
  status: call('status'),
  logs: call('logs'),
  start: call('start'),
  stop: call('stop'),
  router: { install: call('router.install'), update: call('router.update') },
  llama: {
    releases: call('llama.releases'),
    install: call('llama.install'),
    profiles: call('llama.profiles'),
    saveProfile: call('llama.saveProfile'),
    deleteProfile: call('llama.deleteProfile')
  },
  models: {
    dir: call('models.dir'),
    setDir: call('models.setDir'),
    local: call('models.local'),
    search: call('models.search'),
    files: call('models.files'),
    estimate: call('models.estimate'),
    download: call('models.download'),
    remove: call('models.remove')
  },
  hardware: call('hardware'),
  cancelDownload: call('cancelDownload'),
  onStatus: (cb) => listen(CH.status, cb),
  onLog: (cb) => listen(CH.log, cb),
  onProgress: (cb) => listen(CH.progress, cb)
}

const api = {
  components,
  update: {
    onState: (cb: (s: UpdateState) => void): (() => void) => {
      const h = (_: IpcRendererEvent, s: UpdateState): void => cb(s)
      ipcRenderer.on('update:state', h)
      void ipcRenderer.invoke('update:get').then(cb)
      return () => ipcRenderer.removeListener('update:state', h)
    },
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install')
  },
  settings: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('settings:get'),
    set: (p: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('settings:set', p)
  },
  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder')
  }
}

contextBridge.exposeInMainWorld('api', api)
