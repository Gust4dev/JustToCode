import type { Db } from './db'
import type { BlobStore } from './blobs'
import type { EngineEvent } from '@shared/events'

export interface HostContext {
  db: Db
  blobs: BlobStore
  emit(e: EngineEvent): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (params: any) => unknown | Promise<unknown>
export type HandlerModule = (ctx: HostContext) => Record<string, Handler>
