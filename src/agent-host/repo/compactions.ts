import type { CompactionRecord, CompactionTrigger } from '@shared/domain'
import type { Db } from '../db'
import { newId } from '../ids'

interface CompactionRow {
  id: string
  chat_id: string
  from_seq: number
  to_seq: number
  summary_message_id: string
  previous_compaction_id: string | null
  summarizer_model: string
  tokens_before: number
  tokens_after: number
  trigger: string
  created_at: number
}

const toRecord = (r: CompactionRow): CompactionRecord => ({
  id: r.id,
  chatId: r.chat_id,
  fromSeq: r.from_seq,
  toSeq: r.to_seq,
  summaryMessageId: r.summary_message_id,
  previousCompactionId: r.previous_compaction_id,
  summarizerModel: r.summarizer_model,
  tokensBefore: r.tokens_before,
  tokensAfter: r.tokens_after,
  trigger: r.trigger as CompactionTrigger,
  createdAt: r.created_at
})

export class CompactionRepo {
  constructor(private db: Db) {}

  create(r: Omit<CompactionRecord, 'id' | 'createdAt'>): CompactionRecord {
    const row: CompactionRow = {
      id: newId(),
      chat_id: r.chatId,
      from_seq: r.fromSeq,
      to_seq: r.toSeq,
      summary_message_id: r.summaryMessageId,
      previous_compaction_id: r.previousCompactionId,
      summarizer_model: r.summarizerModel,
      tokens_before: r.tokensBefore,
      tokens_after: r.tokensAfter,
      trigger: r.trigger,
      created_at: Date.now()
    }
    this.db
      .prepare(
        `insert into compactions (id, chat_id, from_seq, to_seq, summary_message_id,
           previous_compaction_id, summarizer_model, tokens_before, tokens_after, trigger, created_at)
         values (@id, @chat_id, @from_seq, @to_seq, @summary_message_id, @previous_compaction_id,
           @summarizer_model, @tokens_before, @tokens_after, @trigger, @created_at)`
      )
      .run(row)
    return toRecord(row)
  }

  list(chatId: string): CompactionRecord[] {
    const rows = this.db
      .prepare('select * from compactions where chat_id = ? order by created_at, rowid')
      .all(chatId) as CompactionRow[]
    return rows.map(toRecord)
  }

  get(id: string): CompactionRecord | null {
    const r = this.db.prepare('select * from compactions where id = ?').get(id) as
      CompactionRow | undefined
    return r ? toRecord(r) : null
  }

  last(chatId: string): CompactionRecord | null {
    const r = this.db
      .prepare(
        'select * from compactions where chat_id = ? order by created_at desc, rowid desc limit 1'
      )
      .get(chatId) as CompactionRow | undefined
    return r ? toRecord(r) : null
  }
}
