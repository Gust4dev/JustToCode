import { describe, it, expect } from 'vitest'
import { createRpcClient, createRpcServer, type PortLike } from '@shared/rpc'

function pair(): [PortLike, PortLike] {
  const a: ((d: unknown) => void)[] = []
  const b: ((d: unknown) => void)[] = []
  const mk = (mine: typeof a, other: typeof a): PortLike => ({
    postMessage: (d) => queueMicrotask(() => other.forEach((cb) => cb(structuredClone(d)))),
    onMessage: (cb) => {
      mine.push(cb)
      return () => {
        mine.splice(mine.indexOf(cb), 1)
      }
    }
  })
  return [mk(a, b), mk(b, a)]
}

describe('rpc', () => {
  it('chama método e recebe resultado', async () => {
    const [c, s] = pair()
    createRpcServer(s, { ping: (p: { n: number }) => ({ pong: p.n + 1 }) })
    const client = createRpcClient(c)
    await expect(client.call('ping', { n: 1 })).resolves.toEqual({ pong: 2 })
  })

  it('propaga erro do handler', async () => {
    const [c, s] = pair()
    createRpcServer(s, {
      boom: () => {
        throw new Error('falhou')
      }
    })
    await expect(createRpcClient(c).call('boom')).rejects.toThrow('falhou')
  })

  it('método desconhecido rejeita com code UNKNOWN_METHOD', async () => {
    const [c, s] = pair()
    createRpcServer(s, {})
    await expect(createRpcClient(c).call('nada')).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' })
  })

  it('entrega eventos', async () => {
    const [c, s] = pair()
    const server = createRpcServer(s, {})
    const client = createRpcClient(c)
    const got = new Promise((r) => client.on('tick', r))
    server.emit('tick', { t: 1 })
    await expect(got).resolves.toEqual({ t: 1 })
  })

  it('timeout rejeita', async () => {
    const [c] = pair()
    await expect(createRpcClient(c, { timeoutMs: 20 }).call('x')).rejects.toMatchObject({
      code: 'TIMEOUT'
    })
  })

  it('ignora mensagens malformadas', async () => {
    const [c, s] = pair()
    createRpcServer(s, { ok: () => 1 })
    c.postMessage({ lixo: true })
    await expect(createRpcClient(c).call('ok')).resolves.toBe(1)
  })
})
