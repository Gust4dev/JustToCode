import type { RequestRecord } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface RequestRow {
  id: string
  chat_id: string
  payload_blob_hash: string
  model_requested: string
  model_reported: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  est_tokens: number | null
  effective_window: number | null
  started_at: number
  finished_at: number | null
  error: string | null
}

const toRecord = (r: RequestRow): RequestRecord => ({
  id: r.id,
  chatId: r.chat_id,
  modelRequested: r.model_requested,
  modelReported: r.model_reported,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  estTokens: r.est_tokens,
  effectiveWindow: r.effective_window,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error
})

export class RequestRepo {
  constructor(private db: Db) {}

  start(i: {
    chatId: string
    payloadBlobHash: string
    modelRequested: string
    estTokens: number
    effectiveWindow: number | null
  }): RequestRecord {
    const row: RequestRow = {
      id: newId(),
      chat_id: i.chatId,
      payload_blob_hash: i.payloadBlobHash,
      model_requested: i.modelRequested,
      model_reported: null,
      prompt_tokens: null,
      completion_tokens: null,
      est_tokens: i.estTokens,
      effective_window: i.effectiveWindow,
      started_at: Date.now(),
      finished_at: null,
      error: null
    }
    this.db
      .prepare(
        `insert into requests (id, chat_id, payload_blob_hash, model_requested, model_reported,
           prompt_tokens, completion_tokens, est_tokens, effective_window, started_at, finished_at, error)
         values (@id, @chat_id, @payload_blob_hash, @model_requested, @model_reported,
           @prompt_tokens, @completion_tokens, @est_tokens, @effective_window, @started_at,
           @finished_at, @error)`
      )
      .run(row)
    return toRecord(row)
  }

  finish(
    id: string,
    r: {
      modelReported?: string | null
      promptTokens?: number | null
      completionTokens?: number | null
      error?: string | null
    }
  ): RequestRecord {
    const res = this.db
      .prepare(
        `update requests set model_reported = ?, prompt_tokens = ?, completion_tokens = ?,
           error = ?, finished_at = ? where id = ?`
      )
      .run(
        r.modelReported ?? null,
        r.promptTokens ?? null,
        r.completionTokens ?? null,
        r.error ?? null,
        Date.now(),
        id
      )
    if (res.changes === 0) throw new Error(`Request não encontrado: ${id}`)
    return toRecord(this.db.prepare('select * from requests where id = ?').get(id) as RequestRow)
  }

  list(chatId: string): RequestRecord[] {
    const rows = this.db
      .prepare('select * from requests where chat_id = ? order by started_at, rowid')
      .all(chatId) as RequestRow[]
    return rows.map(toRecord)
  }

  get(id: string): (RequestRecord & { payloadBlobHash: string }) | null {
    const r = this.db.prepare('select * from requests where id = ?').get(id) as
      RequestRow | undefined
    return r ? { ...toRecord(r), payloadBlobHash: r.payload_blob_hash } : null
  }
}
