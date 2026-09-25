import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type Chat } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { createServices, type Services } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { serviceModules } from '../../src/agent-host/handlers'
import type { HostContext } from '../../src/agent-host/context'
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
  o: { models?: unknown[]; chat?: Partial<Pick<Chat, 'maxIterations' | 'tokenBudget'>> } = {}
): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-win-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  writeFileSync(join(root, 'a.txt'), 'alpha\n')
  const router = await startFakeRouter(turns, o.models)
  routers.push(router)
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    routerBaseUrl: router.url,
    routerApiKey: 'sk-test',
    defaultCombo: 'fake/combo',
    routerDbPath: join(base, 'no-router.sqlite'),
    instructionFiles: [],
    skillRoots: [],
    commandRoots: [],
    agentRoots: [],
    pluginRoots: [],
    ruleRoots: []
  }
  const db = openDb(join(base, 'db.sqlite'))
  const blobs = new BlobStore(join(base, 'blobs'))
  const events: EngineEvent[] = []
  const ctx: HostContext = { db, blobs, emit: (e) => events.push(e) }
  const services = createServices(ctx, {
    model: createOpenAiClient(() => cfg),
    getConfig: () => cfg,
    retryDelaysMs: [20, 40]
  })
  const project = services.projects.create(root, 'repo')
  const chat = services.chats.create({
    projectId: project.id,
    title: 't',
    color: '#fff',
    combo: 'fake/combo',
    permissionMode: 'allow-all',
    ...o.chat
  })
  const handlers = Object.assign({}, ...serviceModules(services).map((m) => m(ctx)))
  const call = async (method: string, params: unknown): Promise<unknown> => handlers[method](params)
  return { services, events, router, cfg, chat, call }
}

type End = Extract<EngineEvent, { type: 'turn_finished' | 'turn_error' | 'turn_paused' }>
const isEnd = (e: EngineEvent): e is End =>
  e.type === 'turn_finished' || e.type === 'turn_error' || e.type === 'turn_paused'

async function waitEnds(events: EngineEvent[], n: number, ms = 20_000): Promise<End[]> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ends = events.filter(isEnd)
    if (ends.length >= n) return ends
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('turno não terminou; eventos: ' + events.map((e) => e.type).join(', '))
}

const text = (t: string, model = 'fake/model', usage = true): FakeTurn => ({
  chunks: [chunk.text(t, model), chunk.finish('stop'), ...(usage ? [chunk.usage(100, 5)] : [])]
})
const readCall = (id: string, model = 'fake/model', usage = true): FakeTurn => ({
  chunks: [
    { ...chunk.toolCall(0, id, 'read_file', '{"path":"a.txt"}'), model },
    chunk.finish('tool_calls'),
    ...(usage ? [chunk.usage(100, 5)] : [])
  ]
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isSummaryReq = (b: any): boolean =>
  typeof b?.messages?.[0]?.content === 'string' &&
  b.messages[0].content.startsWith('You compress a coding-agent conversation')

const summaryBody =
  '## Goal\ngoal\n## Decisions\nnone\n## Files and facts\na.txt\n## Done\nx\n## Pending\nnext'

describe('engine: janela pelo modelo que respondeu', () => {
  it('queda Sonnet(1M) → gpt-oss (sufixo cx/): próximo request usa a janela menor e compacta', async () => {
    let main = 0
    const models = [
      { id: 'fake/combo', owned_by: 'combo' },
      { id: 'cc/claude-sonnet', owned_by: 'x', context_length: 1_000_000 },
      { id: 'cx/gpt-oss', owned_by: 'x', context_length: 0 }
    ]
    const env = await setup(
      (body) => {
        if (isSummaryReq(body)) return text(summaryBody)
        main++
        if (main === 1) return readCall('c1', 'cc/claude-sonnet')
        if (main === 2) return readCall('c2', 'gpt-oss') // router caiu para o gpt-oss
        return text('fim', 'gpt-oss')
      },
      { models }
    )
    env.services.comboOverrides.set('fake/combo', { members: ['cc/claude-sonnet', 'cx/gpt-oss'] })
    // histórico que cabe folgado em 1M mas passa do limiar da janela pequena
    for (let i = 1; i <= 20; i++) {
      env.services.messages.append(env.chat.id, {
        role: 'user',
        content: `pergunta antiga ${i} ` + 'palavra longa '.repeat(30)
      })
      env.services.messages.append(env.chat.id, {
        role: 'assistant',
        content: `resposta antiga ${i} ` + 'palavra longa '.repeat(30)
      })
    }
    const baseTokens = env.services.engine.context(env.chat.id).estTokens
    const small = Math.ceil(baseTokens / 0.7) - 200
    models[2].context_length = small
    expect(small).toBeGreaterThan(baseTokens)

    await env.services.engine.send(env.chat.id, 'faça algo', [])
    const [end] = await waitEnds(env.events, 1)
    expect(end.type).toBe('turn_finished')

    const windows = env.services.requests.list(env.chat.id).map((r) => r.effectiveWindow)
    // 1º request: janela do primário; 2º: sticky no Sonnet; 3º: gpt-oss (casado por sufixo).
    expect(windows).toEqual([1_000_000, 1_000_000, small])
    const sw = env.events.filter((e) => e.type === 'provider_switched')
    expect(sw).toEqual([
      {
        type: 'provider_switched',
        chatId: env.chat.id,
        from: 'cc/claude-sonnet',
        to: 'gpt-oss',
        window: small
      }
    ])
    const types = env.events.map((e) => e.type)
    const compIdx = env.events.findIndex(
      (e) => e.type === 'compaction_started' && e.trigger === 'auto'
    )
    expect(compIdx).toBeGreaterThan(types.indexOf('provider_switched'))
    expect(env.services.chats.get(env.chat.id)?.lastReportedModel).toBe('gpt-oss')
    expect(env.services.engine.context(env.chat.id).effectiveWindow).toBe(small)
  })

  it('primeiro request usa a janela do primeiro membro (não o mínimo)', async () => {
    const env = await setup([text('oi', 'm/unknown')], {
      models: [
        { id: 'fake/combo', owned_by: 'combo' },
        { id: 'm/big', owned_by: 'x', context_length: 300_000 },
        { id: 'm/small', owned_by: 'x', context_length: 32_000 }
      ]
    })
    env.services.comboOverrides.set('fake/combo', { members: ['m/big', 'm/small'] })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await waitEnds(env.events, 1)
    expect(env.services.requests.list(env.chat.id)[0].effectiveWindow).toBe(300_000)
  })
})

describe('engine: contínuo e orçamento', () => {
  it('maxIterations null passa de 50 iterações', async () => {
    let n = 0
    const env = await setup(() => (++n <= 55 ? readCall(`c${n}`) : text('fim')), {
      chat: { maxIterations: null }
    })
    await env.services.engine.send(env.chat.id, 'vai', [])
    const [end] = await waitEnds(env.events, 1, 60_000)
    expect(end.type).toBe('turn_finished')
    expect(env.router.requests).toHaveLength(56)
  }, 90_000)

  it('limite de iterações pausa (turn_paused, idle, sem erro)', async () => {
    let n = 0
    const env = await setup(() => readCall(`c${++n}`), { chat: { maxIterations: 2 } })
    await env.services.engine.send(env.chat.id, 'vai', [])
    const [end] = await waitEnds(env.events, 1)
    expect(end).toEqual({ type: 'turn_paused', chatId: env.chat.id, reason: 'iterations' })
    expect(env.router.requests).toHaveLength(2)
    expect(env.events.some((e) => e.type === 'turn_error')).toBe(false)
    expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')
  })

  it('orçamento pausa e engine.continue retoma com contadores zerados', async () => {
    let n = 0
    const env = await setup(() => (++n <= 5 ? readCall(`c${n}`) : text('fim')), {
      chat: { tokenBudget: 150 }
    })
    await env.services.engine.send(env.chat.id, 'vai', [])
    const [paused] = await waitEnds(env.events, 1)
    expect(paused).toEqual({ type: 'turn_paused', chatId: env.chat.id, reason: 'budget' })
    // 2 requests de 105 tokens: o 2º passa de 150
    expect(env.router.requests).toHaveLength(2)
    const budgets = env.events.filter((e) => e.type === 'budget_updated')
    expect(budgets.map((e) => [e.used, e.iterations])).toEqual([
      [105, 1],
      [210, 2]
    ])
    expect(budgets[0]).toMatchObject({ budget: 150, maxIterations: 50 })
    expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')

    env.events.length = 0
    await env.call('engine.continue', { chatId: env.chat.id })
    const [again] = await waitEnds(env.events, 1)
    // novo turno: 105 + 105 ≥ 150 de novo → pausa após mais 2 requests
    expect(again.type).toBe('turn_paused')
    expect(
      env.events.filter((e) => e.type === 'budget_updated').map((e) => [e.used, e.iterations])
    ).toEqual([
      [105, 1],
      [210, 2]
    ])
    env.services.chats.update(env.chat.id, { tokenBudget: null })
    env.events.length = 0
    await env.call('engine.continue', { chatId: env.chat.id })
    const [fin] = await waitEnds(env.events, 1)
    expect(fin.type).toBe('turn_finished')
  })

  it('usage nulo usa estimativa no orçamento', async () => {
    const env = await setup([readCall('c1', 'fake/model', false), text('fim', 'fake/model', false)])
    await env.services.engine.send(env.chat.id, 'vai', [])
    await waitEnds(env.events, 1)
    const budgets = env.events.filter((e) => e.type === 'budget_updated')
    expect(budgets).toHaveLength(2)
    expect(budgets[0].used).toBeGreaterThan(0)
    expect(budgets[1].used).toBeGreaterThan(budgets[0].used)
    expect(budgets[0].budget).toBeNull()
  })
})
