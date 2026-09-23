import { useEffect, useRef } from 'react'
import { ENGINE_EVENT, type EngineEvent } from '@shared/events'
import { onAgentClient } from './agent'

/** Assina os eventos do engine; reinscreve sozinho quando o cliente muda (restart do host). */
export function subscribeEngine(cb: (e: EngineEvent) => void): () => void {
  let offEvent: (() => void) | null = null
  const offClient = onAgentClient((client) => {
    offEvent?.()
    offEvent = client.on(ENGINE_EVENT, (e: EngineEvent) => cb(e))
  })
  return () => {
    offClient()
    offEvent?.()
    offEvent = null
  }
}

export function useEngineEvent(cb: (e: EngineEvent) => void): void {
  const ref = useRef(cb)
  useEffect(() => {
    ref.current = cb
  })
  useEffect(() => subscribeEngine((e) => ref.current(e)), [])
}
