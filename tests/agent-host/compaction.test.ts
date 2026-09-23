import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { ChatRepo } from '../../src/agent-host/repo/chats'
import { MessageRepo } from '../../src/agent-host/repo/messages'
import { CompactionRepo } from '../../src/agent-host/repo/compactions'
import { selectForCompaction, TOOL_IMAGES_TEXT } from '../../src/agent-host/context/select'
import { toTranscript } from '../../src/agent-host/context/transcript'
import {
  SUMMARY_SECTIONS,
  buildSummaryPrompt,
  createSummarizer,
  type Summarizer
} from '../../src/agent-host/context/summarizer'
import {
  SUMMARY_PREFIX,
  compactChat,
  ensureFits,
  summarizerModels,
  type CompactionDeps
} from '../../src/agent-host/context/compaction'
import type { ChatRequest, ModelClient, ModelEvent } from '../../src/agent-host/model/types'
import type { ChatMessage, StoredMessage } from '../../src/shared/domain'
import { DEFAULT_CONFIG } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import type { BlobStore } from '../../src/agent-host/blobs'

const GOOD = SUMMARY_SECTIONS.map((s) => `${s}\n- item`).join('\n\n')

/** ModelClient fake: `replies[model]` = texto ou Error; grava os requests. */
function fakeModel(replies: Record<string, string | Error>): ModelClient & {
  requests: ChatRequest[]
} {
  const requests: ChatRequest[] = []
  return {
    requests,
    async *stream(req: ChatRequest): AsyncIterable<ModelEvent> {
      requests.push(req)
      const r = replies[req.model] ?? GOOD
      if (r instanceof Error) throw r
      for (const chunk of r.match(/[\s\S]{1,10}/g) ?? []) yield { type: 'text_delta', delta: chunk }
      yield { type: 'done', finishReason: 'stop' }
    },
    async listModels() {
      return []
    }
  }
}

let seqCounter = 0
const sm = (message: ChatMessage, kind: 'message' | 'summary' = 'message'): StoredMessage => ({
  id: `m${++seqCounter}`,
  chatId: 'c',
  seq: seqCounter,
  message,
  tokenEst: null,
  modelUsed: null,
  requestId: null,
  compacted: false,
  kind,
  createdAt: 0,
  attachments: []
})
const user = (t: string): ChatMessage => ({ role: 'user', content: t })
const asst = (t: string): ChatMessage => ({ role: 'assistant', content: t })
const call = (id: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }
  ]
})
const tool = (id: string, out = 'ok'): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: out
})

describe('selectForCompaction', () => {
  beforeEach(() => {
    seqCounter = 0
  })

  it('nunca separa um assistant com tool_calls das tools (nem das imagens de ferramenta)', () => {
    const h = [
      sm(user('u1')),
      sm(asst('a1')),
      sm(call('t1')),
      sm(tool('t1')),
      sm({
        role: 'user',
        content: [
          { type: 'text', text: TOOL_IMAGES_TEXT },
          { type: 'image_url', image_url: { url: 'blob:x' } }
        ]
      }),
      sm(asst('a2'))
    ]
    // grupo = seqs 3 (call), 4 (tool), 5 (imagens): sempre inteiro do mesmo lado
    const expected: Record<number, number[]> = {
      1: [1, 2, 3, 4, 5],
      2: [1, 2],
      3: [1, 2],
      4: [1, 2]
    }
    for (const [k, seqs] of Object.entries(expected)) {
      const { toCompact, keep } = selectForCompaction(h, Number(k))
      expect(toCompact.map((m) => m.seq)).toEqual(seqs)
      expect(keep.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6].filter((s) => !seqs.includes(s)))
    }
  })

  it('keepRecent maior que o histórico → nada; keepRecent <= 0 → tudo', () => {
    const h = [sm(user('u1')), sm(asst('a1'))]
    expect(selectForCompaction(h, 10)).toEqual({ toCompact: [], keep: h })
    expect(selectForCompaction(h, 0).toCompact).toHaveLength(2)
  })

  it('summary vigente sempre vai para toCompact e não conta para keepRecent', () => {
    const s = sm(user(SUMMARY_PREFIX + GOOD), 'summary')
    const h = [s, sm(user('u1')), sm(asst('a1')), sm(user('u2')), sm(asst('a2'))]
    const { toCompact, keep } = selectForCompaction(h, 2)
    expect(toCompact.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(keep.map((m) => m.seq)).toEqual([4, 5])
    // só o summary + poucas mensagens: nada a compactar
    expect(selectForCompaction([s, sm(user('x'))], 2).toCompact).toEqual([])
  })
})

describe('toTranscript', () => {
  it('formata papéis, corta saída de ferramenta longa e troca imagens por [image]', () => {
    const t = toTranscript(
      [
        sm(user('oi')),
        sm(call('t1')),
        sm(tool('t1', 'x'.repeat(5000))),
        sm({
          role: 'user',
          content: [
            { type: 'text', text: 'veja' },
            { type: 'image_url', image_url: { url: 'blob:y' } }
          ]
        }),
        sm(asst('feito')),
        sm(user('resumo antigo'), 'summary')
      ],
      100
    )
    expect(t).toContain('USER: oi')
    expect(t).toContain('ASSISTANT → tool read_file({"path":"a.ts"})')
    expect(t).toContain('TOOL RESULT (t1): ' + 'x'.repeat(100) + '…[truncated]')
    expect(t).not.toContain('x'.repeat(101))
    expect(t).toContain('[image]')
    expect(t).toContain('ASSISTANT: feito')
    expect(t).not.toContain('resumo antigo')
  })
})

describe('summarizer', () => {
  it('prompt inclui o resumo anterior', () => {
    const p = buildSummaryPrompt('PREVIOUS SUMMARY', 'USER: hi')
    const text = p.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    expect(text).toContain('PREVIOUS SUMMARY')
    expect(text).toContain('USER: hi')
    for (const s of SUMMARY_SECTIONS) expect(p[0].content).toContain(s)
    expect(JSON.stringify(buildSummaryPrompt(null, 'x'))).not.toContain('previous_summary>')
  })

  it('fallback para o segundo modelo quando o primeiro falha', async () => {
    const m = fakeModel({ a: new Error('boom'), b: GOOD })
    const r = await createSummarizer(m).summarize({
      previous: null,
      messages: [sm(user('x'))],
      models: ['a', 'b']
    })
    expect(r).toEqual({ text: GOOD, model: 'b' })
    expect(m.requests.map((q) => q.model)).toEqual(['a', 'b'])
    expect(m.requests[0].tools).toEqual([])
  })

  it('fallback quando o primeiro devolve sem as seções; todos falham → Error com as mensagens', async () => {
    const m = fakeModel({ a: 'lixo', b: GOOD })
    expect(
      (await createSummarizer(m).summarize({ previous: null, messages: [], models: ['a', 'b'] }))
        .model
    ).toBe('b')
    const bad = fakeModel({ a: 'lixo', b: new Error('caiu') })
    await expect(
      createSummarizer(bad).summarize({ previous: null, messages: [], models: ['a', 'b'] })
    ).rejects.toThrow(/a: .*seções.*b: caiu/)
  })
})

describe('summarizerModels', () => {
  it('únicos, na ordem, ignorando vazios', () => {
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: 'local', lightCombo: 'light' }
    expect(summarizerModels(cfg, 'dev')).toEqual(['local', 'light', 'dev'])
    expect(summarizerModels({ ...DEFAULT_CONFIG, lightCombo: 'dev' }, 'dev')).toEqual(['dev'])
    expect(summarizerModels(DEFAULT_CONFIG, 'dev')).toEqual(['dev'])
  })
})

describe('compactChat / ensureFits', () => {
  let db: Db
  let messages: MessageRepo
  let compactions: CompactionRepo
  let events: EngineEvent[]
  let chatId: string
  let model: ReturnType<typeof fakeModel>
  let deps: CompactionDeps

  const make = (summarizer: Summarizer): CompactionDeps => ({
    ctx: { db, blobs: null as unknown as BlobStore, emit: (e) => events.push(e) },
    messages,
    compactions,
    summarizer
  })
  /** Estimador fake: 100 tokens por mensagem normal, 10 por summary. */
  const estimate = (h: StoredMessage[]): number =>
    h.reduce((n, m) => n + (m.kind === 'summary' ? 10 : 100), 0)
  const fill = (n: number): void => {
    for (let i = 0; i < n; i++) messages.append(chatId, i % 2 ? asst(`a${i}`) : user(`u${i}`))
  }

  beforeEach(() => {
    db = openDb(':memory:')
    messages = new MessageRepo(db)
    compactions = new CompactionRepo(db)
    const p = new ProjectRepo(db).create(mkdtempSync(join(tmpdir(), 'jtc-cmp-')), 'p')
    chatId = new ChatRepo(db).create({
      projectId: p.id,
      title: 't',
      color: '#fff',
      combo: 'dev'
    }).id
    events = []
    model = fakeModel({})
    deps = make(createSummarizer(model))
  })

  it('marca compactadas, cria summary kind summary, emite eventos na ordem e é incremental', async () => {
    fill(10)
    const r1 = await compactChat(deps, {
      chatId,
      trigger: 'manual',
      keepRecent: 4,
      models: ['dev'],
      estimate
    })
    expect(r1).not.toBeNull()
    expect(r1).toMatchObject({
      chatId,
      fromSeq: 1,
      toSeq: 6,
      previousCompactionId: null,
      summarizerModel: 'dev',
      trigger: 'manual',
      tokensBefore: 1000,
      tokensAfter: 410
    })
    const live = messages.list(chatId)
    expect(live.map((m) => m.seq)).toEqual([7, 8, 9, 10, 11])
    const summary = live.find((m) => m.kind === 'summary')!
    expect(summary.id).toBe(r1!.summaryMessageId)
    expect(summary.message).toEqual({ role: 'user', content: SUMMARY_PREFIX + GOOD })
    const all = messages.list(chatId, { includeCompacted: true })
    expect(all.filter((m) => m.compacted).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.map((e) => e.type)).toEqual(['compaction_started', 'compaction_finished'])
    expect(events[1]).toMatchObject({ compaction: r1, summaryMessage: { id: summary.id } })

    // segunda compactação: usa o primeiro resumo como previous e o marca compactado
    fill(4)
    model.requests.length = 0
    const r2 = await compactChat(deps, {
      chatId,
      trigger: 'auto',
      keepRecent: 4,
      models: ['dev'],
      estimate
    })
    expect(r2!.previousCompactionId).toBe(r1!.id)
    expect(JSON.stringify(model.requests[0].messages)).toContain('<previous_summary>')
    expect(messages.get(summary.id)!.compacted).toBe(true)
    const live2 = messages.list(chatId)
    expect(live2.filter((m) => m.kind === 'summary')).toHaveLength(1)
    expect(r2!.fromSeq).toBe(7)
    expect(compactions.list(chatId).map((c) => c.id)).toEqual([r1!.id, r2!.id])
    expect(compactions.last(chatId)!.id).toBe(r2!.id)
    expect(compactions.get(r1!.id)).toEqual(r1)
  })

  it('nada a compactar → null sem eventos', async () => {
    fill(3)
    expect(
      await compactChat(deps, {
        chatId,
        trigger: 'manual',
        keepRecent: 8,
        models: ['dev'],
        estimate
      })
    ).toBeNull()
    expect(events).toEqual([])
  })

  it('falha do summarizer → compaction_failed e nada é marcado', async () => {
    fill(10)
    deps = make(createSummarizer(fakeModel({ dev: 'lixo' })))
    await expect(
      compactChat(deps, { chatId, trigger: 'auto', keepRecent: 2, models: ['dev'], estimate })
    ).rejects.toThrow()
    expect(events.map((e) => e.type)).toEqual(['compaction_started', 'compaction_failed'])
    expect(messages.list(chatId, { includeCompacted: true }).some((m) => m.compacted)).toBe(false)
    expect(messages.list(chatId).some((m) => m.kind === 'summary')).toBe(false)
    expect(compactions.list(chatId)).toEqual([])
  })

  it('ensureFits: abaixo do limiar não faz nada', async () => {
    fill(5)
    expect(
      await ensureFits(deps, {
        chatId,
        window: 1000,
        thresholdPct: 70,
        keepRecent: 4,
        models: ['dev'],
        estimate
      })
    ).toEqual({ compacted: null, fits: true })
    expect(events).toEqual([])
  })

  it('ensureFits: acima do limiar compacta uma vez', async () => {
    fill(10) // 1000 > 700
    const r = await ensureFits(deps, {
      chatId,
      window: 1000,
      thresholdPct: 70,
      keepRecent: 4,
      models: ['dev'],
      estimate
    })
    expect(r.fits).toBe(true)
    expect(r.compacted).toMatchObject({ trigger: 'auto' })
    expect(events.filter((e) => e.type === 'compaction_finished')).toHaveLength(1)
  })

  it('ensureFits: reduz keepRecent pela metade até caber', async () => {
    fill(20) // 250/msg, limite 700: keep 8 → 2010, keep 4 → 1010, keep 2 → 510
    const est250 = (h: StoredMessage[]): number =>
      h.reduce((n, m) => n + (m.kind === 'summary' ? 10 : 250), 0)
    const r = await ensureFits(deps, {
      chatId,
      window: 1000,
      thresholdPct: 70,
      keepRecent: 8,
      models: ['dev'],
      estimate: est250
    })
    expect(r.fits).toBe(true)
    expect(compactions.list(chatId)).toHaveLength(3)
    expect(messages.list(chatId).filter((m) => m.kind !== 'summary')).toHaveLength(2)
  })

  it('ensureFits: histórico enorme que não cabe → fits false', async () => {
    fill(20)
    const r = await ensureFits(deps, {
      chatId,
      window: 100,
      thresholdPct: 70,
      keepRecent: 8,
      models: ['dev'],
      estimate
    })
    expect(r.fits).toBe(false)
    expect(r.compacted).not.toBeNull()
  })

  describe('ensureFits: rodada inútil é pulada (caso E2E: 1 msg curta antiga + longas recentes)', () => {
    /** ~4 chars por token, como o tokenizer real; summaries também contam. */
    const byChars = (h: StoredMessage[]): number =>
      h.reduce((n, m) => {
        const c = m.message.content
        return n + Math.ceil((typeof c === 'string' ? c.length : 0) / 4)
      }, 0)
    const long = 'x'.repeat(4000) // 1000 tokens
    const args = (keepRecent: number): Parameters<typeof ensureFits>[1] => ({
      chatId,
      window: 2000, // limite 1400, mínimo útil 400
      thresholdPct: 70,
      keepRecent,
      models: ['dev'],
      estimate: byChars
    })

    it('não chama o summarizer para compactar só a mensagem curta; vai direto ao keepRecent menor', async () => {
      messages.append(chatId, user('oi'))
      messages.append(chatId, asst(long))
      messages.append(chatId, user(long))
      messages.append(chatId, asst('ok'))
      const r = await ensureFits(deps, args(3)) // keep 3 → só 'oi' (1 token): pulado
      expect(model.requests).toHaveLength(1)
      expect(r.fits).toBe(true)
      expect(r.compacted).toMatchObject({ fromSeq: 1, toSeq: 2 })
      expect(r.compacted!.tokensAfter).toBeLessThan(r.compacted!.tokensBefore)
      expect(compactions.list(chatId)).toHaveLength(1)
    })

    it('nenhuma rodada útil → não compacta e devolve fits pela estimativa', async () => {
      messages.append(chatId, user('oi'))
      messages.append(chatId, asst(long))
      messages.append(chatId, user(long))
      const r = await ensureFits(deps, args(2))
      expect(model.requests).toHaveLength(0)
      expect(events).toEqual([])
      expect(r).toEqual({ compacted: null, fits: false })
    })
  })
})
