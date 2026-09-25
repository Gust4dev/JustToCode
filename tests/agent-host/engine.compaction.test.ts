import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type Chat } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { createServices, type Services, type ServiceOptions } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { serviceModules } from '../../src/agent-host/handlers'
import type { HostContext } from '../../src/agent-host/context'
import { SUMMARY_PREFIX } from '../../src/agent-host/context/compaction'
import {
  chunk,
  startFakeRouter,
  type FakeResponder,
  type FakeRouter,
  type FakeTurn
} from '../helpers/fakeRouter'

const routers: FakeRouter[] = []

afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

interface Env {
  base: string
  services: Services
  events: EngineEvent[]
  router: FakeRouter
  cfg: AppConfig
  chat: Chat
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (method: string, params: unknown) => Promise<any>
}

async function setup(
  turns: FakeTurn[] | FakeResponder,
  o: { cfg?: Partial<AppConfig>; models?: unknown[]; opts?: Partial<ServiceOptions> } = {}
): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-cmp-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  writeFileSync(
    join(root, 'big.txt'),
    Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n') + '\n'
  )
  const router = await startFakeRouter(turns, o.models)
  routers.push(router)
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    routerBaseUrl: router.url,
    routerApiKey: 'sk-test',
    defaultCombo: 'fake/combo',
    routerDbPath: join(base, 'no-router.sqlite'),
    // nunca lê instruções/skills/commands reais do usuário
    instructionFiles: [],
    skillRoots: [],
    commandRoots: [],
    agentRoots: [],
    pluginRoots: [],
    ruleRoots: [],
    ...o.cfg
  }
  const db = openDb(join(base, 'db.sqlite'))
  const blobs = new BlobStore(join(base, 'blobs'))
  const events: EngineEvent[] = []
  const ctx: HostContext = { db, blobs, emit: (e) => events.push(e) }
  const services = createServices(ctx, {
    model: createOpenAiClient(() => cfg),
    getConfig: () => cfg,
    retryDelaysMs: [20, 40],
    ...o.opts
  })
  const project = services.projects.create(root, 'repo')
  const chat = services.chats.create({
    projectId: project.id,
    title: 't',
    color: '#fff',
    combo: 'fake/combo',
    permissionMode: 'allow-all'
  })
  const handlers = Object.assign({}, ...serviceModules(services).map((m) => m(ctx)))
  const call = async (method: string, params: unknown): Promise<unknown> => handlers[method](params)
  return { base, services, events, router, cfg, chat, call }
}

type End = Extract<EngineEvent, { type: 'turn_finished' | 'turn_error' }>
const isEnd = (e: EngineEvent): e is End => e.type === 'turn_finished' || e.type === 'turn_error'

async function waitEnds(events: EngineEvent[], n: number, ms = 15_000): Promise<End[]> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ends = events.filter(isEnd)
    if (ends.length >= n) return ends
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('turno não terminou; eventos: ' + events.map((e) => e.type).join(', '))
}

const textTurn = (t: string): FakeTurn => ({
  chunks: [chunk.text(t), chunk.finish('stop'), chunk.usage(100, 5)]
})
const summaryBody = (tag: string): string =>
  `## Goal\ngoal ${tag}\n## Decisions\nnone\n## Files and facts\nbig.txt\n## Done\n${tag}\n## Pending\nnext`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isSummaryReq = (b: any): boolean =>
  typeof b?.messages?.[0]?.content === 'string' &&
  b.messages[0].content.startsWith('You compress a coding-agent conversation')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contents = (b: any): string[] =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  b.messages.map((m: any) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  )

function seed(s: Services, chatId: string, pairs: number): void {
  for (let i = 1; i <= pairs; i++) {
    s.messages.append(chatId, { role: 'user', content: `pergunta antiga ${i}` })
    s.messages.append(chatId, { role: 'assistant', content: `resposta antiga ${i}` })
  }
}

async function longSession(): Promise<Env> {
  let n = 0
  const models = [{ id: 'fake/combo', owned_by: 'openai', context_length: 0 }]
  const env = await setup(
    (body) => {
      if (isSummaryReq(body)) {
        n++
        return textTurn(summaryBody(`SUMMARY-${n}`))
      }
      return textTurn('resposta ' + 'lorem ipsum dolor '.repeat(60))
    },
    { models }
  )
  // janela pequena: base (system + tools) + ~2.500 tokens, no limiar de 70%
  const base = env.services.engine.context(env.chat.id).estTokens
  models[0].context_length = Math.ceil((base + 2500) / 0.7)
  for (let i = 1; i <= 20; i++) {
    await env.services.engine.send(env.chat.id, `turno ${i} ` + 'palavra longa '.repeat(60), [])
    await waitEnds(env.events, i)
  }
  return env
}

describe('engine + compactação', () => {
  it('sessão longa numa janela pequena compacta e segue sem erro', async () => {
    const env = await longSession()
    const ends = env.events.filter(isEnd)
    expect(ends).toHaveLength(20)
    expect(ends.every((e) => e.type === 'turn_finished')).toBe(true)
    expect(env.events.some((e) => e.type === 'compaction_finished')).toBe(true)

    const reqs = env.router.requests
    const firstSummary = reqs.findIndex(isSummaryReq)
    expect(firstSummary).toBeGreaterThan(0)
    const after = reqs.slice(firstSummary + 1).find((r) => !isSummaryReq(r))
    const c = contents(after)
    expect(after.messages[0].role).toBe('system')
    expect(c[1].startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(c.filter((x) => x.startsWith(SUMMARY_PREFIX))).toHaveLength(1)
    expect(c.some((x) => x.startsWith('turno 1 '))).toBe(false)
    // nada foi apagado: tudo continua no banco, marcado como compactado
    const all = env.services.messages.list(env.chat.id, { includeCompacted: true })
    expect(all.some((m) => m.compacted)).toBe(true)
    expect(all.filter((m) => m.kind !== 'summary')).toHaveLength(40)
    // todo request normal traz o summary vigente logo após o system
    for (const r of reqs.slice(firstSummary + 1).filter((x) => !isSummaryReq(x))) {
      expect(contents(r)[1].startsWith(SUMMARY_PREFIX)).toBe(true)
    }
  }, 60_000)

  it('compactação incremental: a segunda recebe o primeiro resumo no prompt', async () => {
    const env = await longSession()
    const summaries = env.router.requests.filter(isSummaryReq)
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    const prompt = summaries[1].messages[1].content as string
    expect(prompt).toContain('<previous_summary>')
    expect(prompt).toContain('SUMMARY-1')
    const records = env.services.compactions.list(env.chat.id)
    expect(records[1].previousCompactionId).toBe(records[0].id)
    expect(records.every((r) => r.trigger === 'auto')).toBe(true)
  }, 60_000)

  it('overflow: 400 context_length_exceeded → compacta (overflow) e a nova tentativa passa', async () => {
    const env = await setup([
      {
        status: 400,
        errorBody: {
          error: {
            message: "This model's maximum context length is 1000 tokens",
            type: 'invalid_request_error',
            code: 'context_length_exceeded'
          }
        }
      },
      textTurn(summaryBody('OVERFLOW')),
      textTurn('ok depois de compactar')
    ])
    seed(env.services, env.chat.id, 6)
    await env.services.engine.send(env.chat.id, 'continua', [])
    const [end] = await waitEnds(env.events, 1)
    expect(end.type).toBe('turn_finished')
    const started = env.events.filter((e) => e.type === 'compaction_started')
    expect(started).toEqual([
      { type: 'compaction_started', chatId: env.chat.id, trigger: 'overflow' }
    ])
    expect(env.router.requests).toHaveLength(3)
    expect(isSummaryReq(env.router.requests[1])).toBe(true)
    const retry = contents(env.router.requests[2])
    expect(retry[1].startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(retry).not.toContain('pergunta antiga 1')
    // keepRecent reduzido a max(2, 8/2) = 4 mensagens normais mantidas
    const live = env.services.messages.list(env.chat.id)
    expect(live.filter((m) => m.kind !== 'summary').length).toBe(5) // 4 + resposta final
  })

  it('overflow que se repete depois de compactar → CONTEXT_LENGTH', async () => {
    const overflow: FakeTurn = {
      status: 400,
      errorBody: { error: { message: 'context_length_exceeded', code: 'context_length_exceeded' } }
    }
    const env = await setup([overflow, textTurn(summaryBody('X')), overflow])
    seed(env.services, env.chat.id, 6)
    await env.services.engine.send(env.chat.id, 'continua', [])
    const [end] = await waitEnds(env.events, 1)
    expect(end).toMatchObject({ type: 'turn_error', code: 'CONTEXT_LENGTH' })
  })

  it('compaction.run manual, list e get', async () => {
    const env = await setup([textTurn(summaryBody('MANUAL'))])
    seed(env.services, env.chat.id, 6)
    const record = await env.call('compaction.run', { chatId: env.chat.id })
    expect(record).toMatchObject({ chatId: env.chat.id, trigger: 'manual', fromSeq: 1, toSeq: 4 })
    const list = await env.call('compaction.list', { chatId: env.chat.id })
    expect(list.map((r: { id: string }) => r.id)).toEqual([record.id])
    const got = await env.call('compaction.get', { id: record.id })
    expect(got.summary).toBe(summaryBody('MANUAL'))
    expect(got.originals.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4])
    expect(got.originals.every((m: { compacted: boolean }) => m.compacted)).toBe(true)
    expect(env.services.engine.isRunning(env.chat.id)).toBe(false)
  })

  it('compaction.run: CHAT_BUSY com o chat rodando e NOTHING_TO_COMPACT sem histórico', async () => {
    const env = await setup([{ chunks: [chunk.text('pensando...')], hold: true }])
    seed(env.services, env.chat.id, 6)
    await env.services.engine.send(env.chat.id, 'vai', [])
    await expect(env.call('compaction.run', { chatId: env.chat.id })).rejects.toMatchObject({
      code: 'CHAT_BUSY'
    })
    env.services.engine.cancel(env.chat.id)
    await waitEnds(env.events, 1)

    const empty = env.services.chats.create({
      projectId: env.chat.projectId,
      title: 'vazio',
      color: '#fff',
      combo: 'fake/combo',
      permissionMode: 'allow-all'
    })
    env.services.messages.append(empty.id, { role: 'user', content: 'oi' })
    await expect(env.call('compaction.run', { chatId: empty.id })).rejects.toMatchObject({
      code: 'NOTHING_TO_COMPACT'
    })
  })

  const readBig: FakeTurn = {
    chunks: [
      chunk.toolCall(0, 'call_r', 'read_file', JSON.stringify({ path: 'big.txt' })),
      chunk.finish('tool_calls')
    ]
  }

  it('summarizeToolOutputs: saída longa vai resumida', async () => {
    const env = await setup([readBig, textTurn('RESUMO DA SAIDA: 200 linhas'), textTurn('ok')], {
      cfg: { summarizeToolOutputs: true, toolOutputMaxChars: 500 }
    })
    await env.services.engine.send(env.chat.id, 'leia', [])
    const [end] = await waitEnds(env.events, 1)
    expect(end.type).toBe('turn_finished')
    expect(env.router.requests[1].messages[1].content).toContain('line 200')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = env.router.requests[2].messages.find((m: any) => m.role === 'tool')
    const rec = env.services.toolCalls.listByChat(env.chat.id)[0]
    expect(tool.content).toBe(
      `[Tool output summarized — full output: read_tool_output("${rec.id}")]\n` +
        'RESUMO DA SAIDA: 200 linhas'
    )
    expect(rec.outputTruncated).toBe(true)
  })

  it('summarizeToolOutputs com o resumo falhando cai no truncamento', async () => {
    const env = await setup(
      [readBig, { status: 400, errorBody: { error: { message: 'bad request' } } }, textTurn('ok')],
      { cfg: { summarizeToolOutputs: true, toolOutputMaxChars: 500 } }
    )
    await env.services.engine.send(env.chat.id, 'leia', [])
    const [end] = await waitEnds(env.events, 1)
    expect(end.type).toBe('turn_finished')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = env.router.requests[2].messages.find((m: any) => m.role === 'tool')
    expect(tool.content).toContain('characters omitted')
    expect(tool.content).not.toContain('Tool output summarized')
  })

  it('effective_window gravado = janela do primeiro membro da combo (membros lidos do banco do 9router)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jtc-router-'))
    const routerDb = join(dir, 'data.sqlite')
    const rdb = new Database(routerDb)
    rdb.exec(
      'create table combos (id text primary key, name text, kind text, models text, createdAt text, updatedAt text)'
    )
    rdb
      .prepare('insert into combos values (?, ?, ?, ?, ?, ?)')
      .run('c1', 'fake/combo', 'fallback', JSON.stringify(['m/big', 'm/small']), 'now', 'now')
    rdb.close()
    const env = await setup([textTurn('oi')], {
      cfg: { routerDbPath: routerDb },
      models: [
        { id: 'fake/combo', owned_by: 'combo' },
        { id: 'm/big', owned_by: 'x', context_length: 200000 },
        { id: 'm/small', owned_by: 'x', context_length: 32000 }
      ]
    })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await waitEnds(env.events, 1)
    // Antes do 1º modelo reportado: janela do primário (não o mínimo da combo).
    expect(env.services.requests.list(env.chat.id)[0].effectiveWindow).toBe(200000)
    const ctxEv = env.events.filter((e) => e.type === 'context_updated')
    expect(ctxEv.every((e) => e.context.limitingModel === 'm/big')).toBe(true)
    // 'fake/model' (reportado) não tem janela conhecida → continua no primário.
    expect(env.services.engine.context(env.chat.id)).toMatchObject({
      effectiveWindow: 200000,
      limitingModel: 'm/big'
    })
  })

  it('usa o resolver injetado (fake) para a janela', async () => {
    const env = await setup([textTurn('oi')], {
      opts: {
        comboResolver: {
          info: () => Promise.reject(new Error('não usado')),
          effectiveWindow: () => Promise.reject(new Error('não usado')),
          primaryWindow: async () => ({ window: 50000, model: 'x/limit' }),
          windowForReported: async () => null,
          invalidate: () => {}
        }
      }
    })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await waitEnds(env.events, 1)
    expect(env.services.requests.list(env.chat.id)[0].effectiveWindow).toBe(50000)
    expect(env.services.engine.context(env.chat.id).limitingModel).toBe('x/limit')
  })
})
