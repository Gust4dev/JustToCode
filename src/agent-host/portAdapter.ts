import type { PortLike } from '@shared/rpc'

type MessageHandler = (e: { data: unknown }) => void

export type MainPort = {
  postMessage(d: unknown): void
  on(ev: 'message', cb: MessageHandler): unknown
  off(ev: 'message', cb: MessageHandler): unknown
  start(): void
}

export function toPortLikeMain(port: MainPort): PortLike {
  port.start()
  return {
    postMessage: (d) => port.postMessage(d),
    onMessage: (cb) => {
      const h: MessageHandler = (e) => cb(e.data)
      port.on('message', h)
      return () => {
        port.off('message', h)
      }
    }
  }
}
