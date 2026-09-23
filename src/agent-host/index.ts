import { join } from 'node:path'
import { createRpcServer, type RpcServer } from '@shared/rpc'
import { ENGINE_EVENT } from '@shared/events'
import type { AppConfig } from '@shared/domain'
import { toPortLikeMain } from './portAdapter'
import { openDb } from './db'
import { BlobStore } from './blobs'
import { setConfig } from './config'
import type { Handler, HostContext } from './context'
import { modules, serviceModules } from './handlers'
import { createServices } from './services'
import { warmTokenizer } from './context/tokenizer'

const dataDir = process.env.JTC_USER_DATA ?? process.cwd()
const db = openDb(join(dataDir, 'justtocode.sqlite'))
export const blobs = new BlobStore(join(dataDir, 'blobs'))

const servers = new Set<RpcServer>()

const ctx: HostContext = {
  db,
  blobs,
  emit: (e) => servers.forEach((s) => s.emit(ENGINE_EVENT, e))
}

const handlers: Record<string, Handler> = {}
const services = createServices(ctx, { watch: true })
// O host é encerrado pelo main; soltar os watchers é o melhor esforço possível aqui.
process.once('exit', () => void services.watcher.stopAll())
for (const m of [...modules, ...serviceModules(services)]) Object.assign(handlers, m(ctx))

process.parentPort.on('message', (e) => {
  const data = e.data as { type?: string; config?: Partial<AppConfig> } | null
  if (data?.type === 'config') {
    if (data.config) setConfig(data.config)
    return
  }
  if (data?.type !== 'port') return
  const [port] = e.ports
  if (!port) return
  const server = createRpcServer(toPortLikeMain(port), handlers)
  servers.add(server)
  port.on('close', () => {
    server.dispose()
    servers.delete(server)
  })
})

// Aquece o tokenizer depois de registrar handlers e o listener de portas (não atrasa o RPC).
setTimeout(warmTokenizer, 0)
