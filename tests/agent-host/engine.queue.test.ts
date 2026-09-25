import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
import { cleanTitle } from '../../src/agent-host/engine/title'
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
  projectId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (method: string, params: unknown) => Promise<any>
}

async function setup(
  respond: FakeResponder,
  o: { title?: string; cfg?: Partial<AppConfig> } = {}
): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-queue-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  const router = await startFakeRouter(respond)
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
    retryDelaysMs: [5, 5]
  })
  const project = services.projects.create(root, 'repo')
  const chat = services.chats.create({
    projectId: project.id,
    title: o.title ?? 't',
    color: '#fff',
    combo: 'fake/combo',
    permissionMode: 'allow-all'
  })
  const handlers = Object.assign({}, ...serviceModules(services).map((m) => m(ctx)))
  const call = async (method: string, params: unknown): Promise<unknown> => handlers[method](params)
  return { services, events, router, cfg, chat, projectId: project.id, call }
}

type End = Extract<EngineEvent, { type: 'turn_finished' | 'turn_error' }>
const isEnd = (e: EngineEvent): e is End => e.type === 'turn_finished' || e.type === 'turn_error'

async function until(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout: ${what}`)
}

const waitEnds = (env: Env, n: number): Promise<void> =>
  until(() => env.events.filter(isEnd).length >= n, `${n} fins de turno`)

const textTurn = (t: string): FakeTurn => ({
  chunks: [chunk.text(t), chunk.finish('stop'), chunk.usage(100, 5)]
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isTitleReq = (b: any): boolean =>
  typeof b?.messages?.[0]?.content === 'string' &&
  b.messages[0].content.startsWith('You write a short title')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastUser = (b: any): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u = [...b.messages].reverse().find((m: any) => m.role === 'user')
  return typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content)
}

/** Responde `re:<última mensagem>`; `boom` → erro 400; `hold` → segura até cancelar. */
const echo =
  (title = 'Título gerado aqui'): FakeResponder =>
  (b) => {
    if (isTitleReq(b)) return textTurn(title)
    const u = lastUser(b)
    if (u === 'boom') return { status: 400, errorBody: { error: { message: 'deu ruim' } } }
    if (u === 'hold') return { chunks: [chunk.text('...')], hold: true }
    return textTurn(`re:${u}`)
  }

const userTexts = (env: Env): string[] =>
  env.services.messages
    .list(env.chat.id)
    .filter((m) => m.message.role === 'user')
    .map((m) => {
      const c = m.message.content
      if (typeof c === 'string') return c
      return (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).find((t) => t) ?? ''
    })

describe('fila de mensagens', () => {
  it('3 mensagens enfileiradas com o chat ocupado saem em ordem', async () => {
    const env = await setup(echo())
    const first = await env.services.engine.send(env.chat.id, 'm0', [])
    expect(first.messageId).toBeTruthy()
    expect(first.queuedId).toBeNull()
    const queued: { messageId: string | null; queuedId: string | null }[] = []
    for (const t of ['m1', 'm2', 'm3'])
      queued.push(await env.services.engine.send(env.chat.id, t, []))
    for (const q of queued) {
      expect(q.messageId).toBeNull()
      expect(q.queuedId).toBeTruthy()
    }
    expect(
      (await env.call('queue.get', { chatId: env.chat.id })).items.map(
        (i: { text: string }) => i.text
      )
    ).toEqual(['m1', 'm2', 'm3'])
    expect(env.events.some((e) => e.type === 'queue_changed')).toBe(true)

    await waitEnds(env, 4)
    expect(env.events.filter(isEnd).every((e) => e.type === 'turn_finished')).toBe(true)
    expect(userTexts(env)).toEqual(['m0', 'm1', 'm2', 'm3'])
    const asked = env.router.requests.filter((b) => !isTitleReq(b)).map(lastUser)
    expect(asked).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(env.services.engine.queue.get(env.chat.id).items).toEqual([])
    expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')
  })

  it('erro no turno pausa a fila; resume drena na ordem', async () => {
    const env = await setup(echo())
    await env.services.engine.send(env.chat.id, 'boom', [])
    await env.services.engine.send(env.chat.id, 'a', [])
    await env.services.engine.send(env.chat.id, 'b', [])
    await waitEnds(env, 1)
    expect(env.events.find(isEnd)).toMatchObject({ type: 'turn_error' })
    await until(() => env.services.engine.queue.get(env.chat.id).paused, 'fila pausada')
    const paused = await env.call('queue.get', { chatId: env.chat.id })
    expect(paused.paused).toBe(true)
    expect(paused.pauseReason).toContain('deu ruim')
    expect(paused.items.map((i: { text: string }) => i.text)).toEqual(['a', 'b'])

    // fila pausada com itens: novo envio também entra na fila, sem rodar
    const c = await env.services.engine.send(env.chat.id, 'c', [])
    expect(c.queuedId).toBeTruthy()
    await new Promise((r) => setTimeout(r, 100))
    expect(env.router.requests.filter((b) => !isTitleReq(b))).toHaveLength(1)

    const resumed = await env.call('queue.resume', { chatId: env.chat.id })
    expect(resumed.paused).toBe(false)
    await waitEnds(env, 4)
    expect(userTexts(env)).toEqual(['boom', 'a', 'b', 'c'])
    expect(env.services.engine.queue.get(env.chat.id)).toMatchObject({ paused: false, items: [] })
  })

  it('remove/edit; cancelamento pausa e resume envia o texto editado', async () => {
    const env = await setup(echo())
    await env.services.engine.send(env.chat.id, 'hold', [])
    const a = await env.services.engine.send(env.chat.id, 'a', [])
    const b = await env.services.engine.send(env.chat.id, 'b', [])
    const c = await env.services.engine.send(env.chat.id, 'c', [
      { name: 'n.txt', mime: 'text/plain', dataBase64: Buffer.from('anexo!').toString('base64') }
    ])
    const afterRemove = await env.call('queue.remove', { id: b.queuedId })
    expect(afterRemove.items.map((i: { id: string }) => i.id)).toEqual([a.queuedId, c.queuedId])
    const afterEdit = await env.call('queue.edit', { id: c.queuedId, text: 'c editado' })
    expect(afterEdit.items.map((i: { text: string }) => i.text)).toEqual(['a', 'c editado'])
    expect(afterEdit.items[1].attachments).toHaveLength(1)
    await expect(env.call('queue.remove', { id: 'nao-existe' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    await until(() => env.events.some((e) => e.type === 'text_delta'), 'turno segurado')
    env.services.engine.cancel(env.chat.id)
    await waitEnds(env, 1)
    await until(() => env.services.engine.queue.get(env.chat.id).paused, 'fila pausada')
    expect(env.services.engine.queue.get(env.chat.id).pauseReason).toBe('turno cancelado')

    await env.call('queue.resume', { chatId: env.chat.id })
    await waitEnds(env, 3)
    expect(userTexts(env)).toEqual(['hold', 'a', 'c editado'])
    const withFile = env.services.messages
      .list(env.chat.id)
      .filter((m) => m.message.role === 'user')[2]
    expect(withFile.attachments.map((x) => x.name)).toEqual(['n.txt'])
    const lastReq = env.router.requests.filter((r) => !isTitleReq(r)).pop()
    expect(JSON.stringify(lastReq.messages)).toContain('anexo!')
  })

  it('compactação manual em andamento: envio entra na fila e sai depois', async () => {
    const summary = '## Goal\ng\n## Decisions\nd\n## Files and facts\nf\n## Done\nx\n## Pending\ny'
    const env = await setup((b) => {
      if (
        typeof b?.messages?.[0]?.content === 'string' &&
        b.messages[0].content.startsWith('You compress')
      ) {
        return textTurn(summary)
      }
      return echo()(b)
    })
    for (let i = 1; i <= 10; i++) {
      env.services.messages.append(env.chat.id, { role: 'user', content: `p${i}` })
      env.services.messages.append(env.chat.id, { role: 'assistant', content: `r${i}` })
    }
    const compacting = env.call('compaction.run', { chatId: env.chat.id })
    const sent = await env.services.engine.send(env.chat.id, 'depois', [])
    expect(sent.queuedId).toBeTruthy()
    await compacting
    await waitEnds(env, 1)
    expect(env.events.find(isEnd)?.type).toBe('turn_finished')
    expect(userTexts(env).pop()).toBe('depois')
  })
})

describe('título automático', () => {
  it('gera uma vez após o 1º turno de um "Novo chat" e emite chat_updated', async () => {
    const env = await setup(echo('"Configurar o build do projeto agora mesmo, por favor."'), {
      title: 'Novo chat'
    })
    await env.services.engine.send(env.chat.id, 'como configuro o build?', [])
    await until(() => env.events.some((e) => e.type === 'chat_updated'), 'chat_updated')
    const updated = env.events.find(
      (e): e is Extract<EngineEvent, { type: 'chat_updated' }> => e.type === 'chat_updated'
    )
    expect(updated?.chat.title).toBe('Configurar o build do projeto agora')
    expect(env.services.chats.get(env.chat.id)?.title).toBe('Configurar o build do projeto agora')
    const titleReq = env.router.requests.find(isTitleReq)
    expect(titleReq.model).toBe('fake/combo')
    expect(JSON.stringify(titleReq.messages)).toContain('como configuro o build?')

    await env.services.engine.send(env.chat.id, 'e agora?', [])
    await waitEnds(env, 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(env.router.requests.filter(isTitleReq)).toHaveLength(1)
  })

  it('usa lightCombo antes de defaultCombo', async () => {
    const env = await setup(echo(), { title: 'Novo chat', cfg: { lightCombo: 'fake/light' } })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await until(() => env.events.some((e) => e.type === 'chat_updated'), 'chat_updated')
    expect(env.router.requests.find(isTitleReq).model).toBe('fake/light')
  })

  it('não sobrescreve título editado e falha é silenciosa', async () => {
    const edited = await setup(echo(), { title: 'Meu título' })
    await edited.services.engine.send(edited.chat.id, 'oi', [])
    await waitEnds(edited, 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(edited.router.requests.filter(isTitleReq)).toHaveLength(0)
    expect(edited.services.chats.get(edited.chat.id)?.title).toBe('Meu título')

    const failing = await setup(
      (b) =>
        isTitleReq(b) ? { status: 400, errorBody: { error: { message: 'x' } } } : textTurn('ok'),
      { title: 'Novo chat' }
    )
    await failing.services.engine.send(failing.chat.id, 'oi', [])
    await waitEnds(failing, 1)
    await until(() => failing.router.requests.some(isTitleReq), 'request de título')
    await new Promise((r) => setTimeout(r, 100))
    expect(failing.events.filter(isEnd).map((e) => e.type)).toEqual(['turn_finished'])
    expect(failing.events.some((e) => e.type === 'chat_updated')).toBe(false)
    expect(failing.services.chats.get(failing.chat.id)?.title).toBe('Novo chat')
  })

  it('chats.generateTitle manual regrava o título', async () => {
    const env = await setup(echo('Título manual'))
    await env.services.engine.send(env.chat.id, 'refatorar o parser', [])
    await waitEnds(env, 1)
    const chat = await env.call('chats.generateTitle', { chatId: env.chat.id })
    expect(chat.title).toBe('Título manual')
    expect(env.services.chats.get(env.chat.id)?.title).toBe('Título manual')
    expect(env.events.some((e) => e.type === 'chat_updated')).toBe(true)
    await expect(env.call('chats.generateTitle', { chatId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('cleanTitle limpa aspas, rótulo, pontuação e corta em 6 palavras', () => {
    expect(cleanTitle('Title: "Um dois três quatro cinco seis sete."')).toBe(
      'Um dois três quatro cinco seis'
    )
    expect(cleanTitle('\n**Corrigir bug**\nexplicação')).toBe('Corrigir bug')
    expect(cleanTitle('   ')).toBe('')
  })
})
