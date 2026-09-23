import type { AppConfig, CompactionRecord, CompactionTrigger, StoredMessage } from '@shared/domain'
import type { HostContext } from '../context'
import type { MessageRepo } from '../repo/messages'
import type { CompactionRepo } from '../repo/compactions'
import type { Summarizer } from './summarizer'
import { selectForCompaction } from './select'

export const SUMMARY_PREFIX = '[Summary of the earlier conversation — use it as context]\n\n'

export interface CompactionDeps {
  ctx: HostContext
  messages: MessageRepo
  compactions: CompactionRepo
  summarizer: Summarizer
}

/** Únicos, na ordem: cfg.summarizerModel, cfg.lightCombo, chatCombo (ignora vazios). */
export function summarizerModels(cfg: AppConfig, chatCombo: string): string[] {
  const out: string[] = []
  for (const m of [cfg.summarizerModel, cfg.lightCombo, chatCombo]) {
    const v = m?.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Texto do summary sem o prefixo fixo. */
export function summaryText(m: StoredMessage): string {
  const c = m.message.content
  let s = ''
  if (typeof c === 'string') s = c
  else if (Array.isArray(c)) s = c.map((p) => (p.type === 'text' ? p.text : '')).join('')
  return s.startsWith(SUMMARY_PREFIX) ? s.slice(SUMMARY_PREFIX.length) : s
}

export async function compactChat(
  d: CompactionDeps,
  p: {
    chatId: string
    trigger: CompactionTrigger
    keepRecent: number
    models: string[]
    estimate: (history: StoredMessage[]) => number
    signal?: AbortSignal
  }
): Promise<CompactionRecord | null> {
  const history = d.messages.list(p.chatId)
  const { toCompact } = selectForCompaction(history, p.keepRecent)
  if (!toCompact.some((m) => m.kind !== 'summary')) return null

  const prevSummary = [...history].reverse().find((m) => m.kind === 'summary') ?? null
  const previous = prevSummary ? summaryText(prevSummary) : null
  const tokensBefore = p.estimate(history)

  d.ctx.emit({ type: 'compaction_started', chatId: p.chatId, trigger: p.trigger })
  try {
    const { text, model } = await d.summarizer.summarize({
      previous,
      messages: toCompact,
      models: p.models,
      signal: p.signal
    })
    const commit = d.ctx.db.transaction(() => {
      const summaryMessage = d.messages.append(
        p.chatId,
        { role: 'user', content: SUMMARY_PREFIX + text },
        { kind: 'summary', modelUsed: model }
      )
      const seqs = toCompact.map((m) => m.seq)
      d.messages.markCompacted(p.chatId, seqs)
      const record = d.compactions.create({
        chatId: p.chatId,
        fromSeq: Math.min(...seqs),
        toSeq: Math.max(...seqs),
        summaryMessageId: summaryMessage.id,
        previousCompactionId: d.compactions.last(p.chatId)?.id ?? null,
        summarizerModel: model,
        tokensBefore,
        tokensAfter: p.estimate(d.messages.list(p.chatId)),
        trigger: p.trigger
      })
      return { summaryMessage, record }
    })
    const { summaryMessage, record } = commit()
    d.ctx.emit({
      type: 'compaction_finished',
      chatId: p.chatId,
      compaction: record,
      summaryMessage
    })
    return record
  } catch (e) {
    d.ctx.emit({
      type: 'compaction_failed',
      chatId: p.chatId,
      message: e instanceof Error ? e.message : String(e)
    })
    throw e
  }
}

export async function ensureFits(
  d: CompactionDeps,
  p: {
    chatId: string
    window: number
    thresholdPct: number
    keepRecent: number
    models: string[]
    estimate: (history: StoredMessage[]) => number
    signal?: AbortSignal
  }
): Promise<{ compacted: CompactionRecord | null; fits: boolean }> {
  const limit = (p.window * p.thresholdPct) / 100
  const fits = (): boolean => p.estimate(d.messages.list(p.chatId)) <= limit
  if (fits()) return { compacted: null, fits: true }

  // Rodada que liberaria poucos tokens gasta uma chamada ao summarizer e pode até aumentar o contexto.
  const minUseful = Math.max(400, limit * 0.1)
  const usefulTokens = (keep: number): number => {
    const history = d.messages.list(p.chatId)
    const { toCompact } = selectForCompaction(history, keep)
    const gone = new Set(toCompact.filter((m) => m.kind !== 'summary').map((m) => m.seq))
    if (gone.size === 0) return 0
    return p.estimate(history) - p.estimate(history.filter((m) => !gone.has(m.seq)))
  }

  let compacted: CompactionRecord | null = null
  let keep = p.keepRecent
  for (;;) {
    if (usefulTokens(keep) < minUseful) {
      if (keep <= 2) return { compacted, fits: fits() }
      keep = Math.max(2, Math.floor(keep / 2))
      continue
    }
    const r = await compactChat(d, {
      chatId: p.chatId,
      trigger: 'auto',
      keepRecent: keep,
      models: p.models,
      estimate: p.estimate,
      signal: p.signal
    })
    if (r) compacted = r
    if (fits()) return { compacted, fits: true }
    if (keep <= 2) return { compacted, fits: false }
    keep = Math.max(2, Math.floor(keep / 2))
  }
}
