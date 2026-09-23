import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { toPortLikeMain } from '../../src/agent-host/portAdapter'

describe('toPortLikeMain', () => {
  it('encaminha data das mensagens e permite desinscrever', () => {
    const sent: unknown[] = []
    const fake = Object.assign(new EventEmitter(), {
      postMessage: (d: unknown) => sent.push(d),
      start: () => {}
    })
    const port = toPortLikeMain(fake)
    const got: unknown[] = []
    const off = port.onMessage((d) => got.push(d))
    fake.emit('message', { data: { a: 1 } })
    off()
    fake.emit('message', { data: { a: 2 } })
    port.postMessage({ b: 1 })
    expect(got).toEqual([{ a: 1 }])
    expect(sent).toEqual([{ b: 1 }])
  })
})
