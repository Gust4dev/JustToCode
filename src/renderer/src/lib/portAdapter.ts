import type { PortLike } from '@shared/rpc'

export function toPortLikeDom(port: MessagePort): PortLike {
  port.start()
  return {
    postMessage: (d) => port.postMessage(d),
    onMessage: (cb) => {
      const h = (e: MessageEvent): void => cb(e.data)
      port.addEventListener('message', h)
      return () => port.removeEventListener('message', h)
    }
  }
}
