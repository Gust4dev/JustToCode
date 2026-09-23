import type { Db } from '../db'

export class ModelWindowRepo {
  constructor(private db: Db) {}

  get(modelId: string): number | null {
    const r = this.db
      .prepare('select context_window from model_windows where model_id = ?')
      .get(modelId) as { context_window: number } | undefined
    return r?.context_window ?? null
  }

  /** `null` apaga o override. */
  set(modelId: string, contextWindow: number | null, source = 'manual'): void {
    if (contextWindow == null) {
      this.db.prepare('delete from model_windows where model_id = ?').run(modelId)
      return
    }
    this.db
      .prepare(
        `insert into model_windows (model_id, context_window, source) values (?, ?, ?)
         on conflict(model_id) do update set context_window = excluded.context_window,
           source = excluded.source`
      )
      .run(modelId, contextWindow, source)
  }
}
