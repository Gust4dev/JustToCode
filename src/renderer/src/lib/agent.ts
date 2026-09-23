import { createRpcClient, type RpcClient } from '@shared/rpc'
import { toPortLikeDom } from './portAdapter'

let current: RpcClient | null = null
let currentPort: MessagePort | null = null
let waiters: ((c: RpcClient) => void)[] = []
const clientListeners = new Set<(c: RpcClient) => void>()

// O preload repassa a porta do agent-host via window.postMessage (mesma janela).
// Uma porta nova chega a cada carga do renderer e a cada restart do host.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data !== 'agent-port' || !e.ports[0]) return
  current?.dispose()
  currentPort?.close()
  currentPort = e.ports[0]
  const client = createRpcClient(toPortLikeDom(currentPort))
  current = client
  waiters.forEach((w) => w(client))
  waiters = []
  clientListeners.forEach((l) => l(client))
})

export function getAgent(): Promise<RpcClient> {
  return current ? Promise.resolve(current) : new Promise((r) => waiters.push(r))
}

/** Chama cb com o cliente atual (se houver) e a cada cliente novo (recarga ou restart do host). */
export function onAgentClient(cb: (c: RpcClient) => void): () => void {
  clientListeners.add(cb)
  if (current) cb(current)
  return () => {
    clientListeners.delete(cb)
  }
}
