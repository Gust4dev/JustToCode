import { Envelope, type ResMsg } from './protocol'

export interface PortLike {
  postMessage(data: unknown): void
  onMessage(cb: (data: unknown) => void): () => void
}

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

// Handlers e listeners recebem dados já validados pelo envelope; o tipo do payload é do chamador.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (params: any) => unknown | Promise<unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (payload: any) => void

export interface RpcServer {
  emit(name: string, payload: unknown): void
  dispose(): void
}

export interface RpcClient {
  call<T>(method: string, params?: unknown): Promise<T>
  on(name: string, cb: Listener): () => void
  dispose(): void
}

export function createRpcServer(port: PortLike, handlers: Record<string, Handler>): RpcServer {
  const off = port.onMessage(async (raw) => {
    const parsed = Envelope.safeParse(raw)
    if (!parsed.success || parsed.data.kind !== 'req') return
    const { id, method, params } = parsed.data
    const handler = Object.prototype.hasOwnProperty.call(handlers, method)
      ? handlers[method]
      : undefined
    let res: ResMsg
    if (!handler) {
      res = {
        kind: 'res',
        id,
        ok: false,
        error: { message: `método desconhecido: ${method}`, code: 'UNKNOWN_METHOD' }
      }
    } else {
      try {
        res = { kind: 'res', id, ok: true, result: await handler(params) }
      } catch (e) {
        const err = e as Partial<RpcError> | null
        const message = typeof err?.message === 'string' ? err.message : String(e)
        const code = typeof err?.code === 'string' ? err.code : undefined
        res = { kind: 'res', id, ok: false, error: { message, code } }
      }
    }
    port.postMessage(res)
  })
  return {
    emit: (name, payload) => port.postMessage({ kind: 'event', name, payload }),
    dispose: off
  }
}

export function createRpcClient(port: PortLike, opts: { timeoutMs?: number } = {}): RpcClient {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const pending = new Map<
    string,
    {
      resolve: (v: unknown) => void
      reject: (e: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const listeners = new Map<string, Set<Listener>>()
  let seq = 0

  const off = port.onMessage((raw) => {
    const parsed = Envelope.safeParse(raw)
    if (!parsed.success) return
    const msg = parsed.data
    if (msg.kind === 'event') listeners.get(msg.name)?.forEach((cb) => cb(msg.payload))
    if (msg.kind === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new RpcError(msg.error.message, msg.error.code))
    }
  })

  return {
    call<T>(method: string, params?: unknown): Promise<T> {
      const id = `${Date.now()}-${++seq}`
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new RpcError(`timeout em ${method}`, 'TIMEOUT'))
        }, timeoutMs)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        port.postMessage({ kind: 'req', id, method, params: params ?? null })
      })
    },
    on(name, cb) {
      let set = listeners.get(name)
      if (!set) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(cb)
      return () => {
        listeners.get(name)?.delete(cb)
      }
    },
    dispose() {
      off()
      pending.forEach((p) => {
        clearTimeout(p.timer)
        p.reject(new RpcError('cliente descartado', 'DISPOSED'))
      })
      pending.clear()
      listeners.clear()
    }
  }
}
