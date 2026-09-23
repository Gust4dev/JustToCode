import type { ToolCallRecord, ToolCallStatus } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface ToolCallRow {
  id: string
  message_id: string
  chat_id: string
  model_call_id: string | null
  name: string
  args_json: string
  status: string
  output_blob_hash: string | null
  output_preview: string | null
  output_truncated: number
  started_at: number | null
  finished_at: number | null
}

const toRecord = (r: ToolCallRow): ToolCallRecord => ({
  id: r.id,
  modelCallId: r.model_call_id ?? '',
  messageId: r.message_id,
  chatId: r.chat_id,
  name: r.name,
  args: JSON.parse(r.args_json) as unknown,
  status: r.status as ToolCallStatus,
  outputPreview: r.output_preview,
  outputTruncated: r.output_truncated === 1,
  startedAt: r.started_at,
  finishedAt: r.finished_at
})

export type ToolCallPatch = Partial<{
  status: ToolCallStatus
  outputBlobHash: string
  outputPreview: string
  outputTruncated: boolean
  startedAt: number
  finishedAt: number
}>

const columns: Record<keyof ToolCallPatch, string> = {
  status: 'status',
  outputBlobHash: 'output_blob_hash',
  outputPreview: 'output_preview',
  outputTruncated: 'output_truncated',
  startedAt: 'started_at',
  finishedAt: 'finished_at'
}

export class ToolCallRepo {
  constructor(private db: Db) {}

  create(i: {
    messageId: string
    chatId: string
    modelCallId: string
    name: string
    args: unknown
  }): ToolCallRecord {
    const row: ToolCallRow = {
      id: newId(),
      message_id: i.messageId,
      chat_id: i.chatId,
      model_call_id: i.modelCallId,
      name: i.name,
      args_json: JSON.stringify(i.args ?? null),
      status: 'pending',
      output_blob_hash: null,
      output_preview: null,
      output_truncated: 0,
      started_at: null,
      finished_at: null
    }
    this.db
      .prepare(
        `insert into tool_calls (id, message_id, chat_id, model_call_id, name, args_json, status,
           output_blob_hash, output_preview, output_truncated, started_at, finished_at)
         values (@id, @message_id, @chat_id, @model_call_id, @name, @args_json, @status,
           @output_blob_hash, @output_preview, @output_truncated, @started_at, @finished_at)`
      )
      .run(row)
    return toRecord(row)
  }

  update(id: string, p: ToolCallPatch): ToolCallRecord {
    const sets: string[] = []
    const values: (string | number)[] = []
    for (const key of Object.keys(columns) as (keyof ToolCallPatch)[]) {
      const v = p[key]
      if (v === undefined) continue
      sets.push(`${columns[key]} = ?`)
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
    }
    if (sets.length > 0) {
      this.db.prepare(`update tool_calls set ${sets.join(', ')} where id = ?`).run(...values, id)
    }
    const r = this.db.prepare('select * from tool_calls where id = ?').get(id) as
      ToolCallRow | undefined
    if (!r) throw new Error(`Tool call não encontrado: ${id}`)
    return toRecord(r)
  }

  get(id: string): (ToolCallRecord & { outputBlobHash: string | null }) | null {
    const r = this.db.prepare('select * from tool_calls where id = ?').get(id) as
      ToolCallRow | undefined
    return r ? { ...toRecord(r), outputBlobHash: r.output_blob_hash } : null
  }

  listByChat(chatId: string): ToolCallRecord[] {
    const rows = this.db
      .prepare('select * from tool_calls where chat_id = ? order by rowid')
      .all(chatId) as ToolCallRow[]
    return rows.map(toRecord)
  }
}
