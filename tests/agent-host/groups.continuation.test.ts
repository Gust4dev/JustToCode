import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type Chat } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import type { HostContext, Handler } from '../../src/agent-host/context'
import { createServices, type Services } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { modules, serviceModules } from '../../src/agent-host/handlers'
import { SUMMARY_PREFIX, summaryText } from '../../src/agent-host/context/compaction'
import { SUMMARY_SECTIONS } from '../../src/agent-host/context/summarizer'
import { chunk, startFakeRouter, type FakeRouter, type FakeTurn } from '../helpers/fakeRouter'

const routers: FakeRouter[] = []

afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any

interface Env {
  ctx: HostContext
  services: Services
  events: EngineEvent[]
  router: FakeRouter
  h: Record<string, Handler>
  chat: Chat
}

const SUMMARY = SUMMARY_SECTIONS.map((s) => `${s}\nitem`).join('\n')

const isSummarize = (b: Body): boolean =>
  typeof b.messages[0]?.content === 'string' && b.messages[0].content.includes('You compress')
const userText = (b: Body): string =>
  b.messages
    .filter((x: Body) => x.role === 'user')
    .map((x: Body) => (typeof x.content === 'string' ? x.content : ''))
    .join('\n')
const firstUser = (b: Body): string => {
  const m = b.messages.find((x: Body) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : ''
}
const toolCount = (b: Body): number => b.messages.filter((x: Body) => x.role === 'tool').length

const text = (t: string): FakeTurn => ({
  chunks: [chunk.text(t), chunk.finish('stop'), chunk.usage(10, 2)]
})
const calls = (...cs: [string, string, Record<string, unknown>][]): FakeTurn => ({
  chunks: [
    ...cs.map(([id, name, args], i) => chunk.toolCall(i, id, name, JSON.stringify(args))),
    chunk.finish('tool_calls')
  ]
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function setup(respond: (b: Body) => FakeTurn | undefined): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-groups-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'a.txt'), 'alpha\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')

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
    ruleRoots: []
  }
  const db = openDb(join(base, 'db.sqlite'))
  const blobs = new BlobStore(join(base, 'blobs'))
  const events: EngineEvent[] = []
  const ctx: HostContext = { db, blobs, emit: (e) => events.push(e) }
  const services = createServices(ctx, {
    model: createOpenAiClient(() => cfg),
    getConfig: () => cfg,
    retryDelaysMs: [10]
  })
  const h: Record<string, Handler> = Object.assign(
    {},
    ...modules.map((m) => m(ctx)),
    ...serviceModules(services).map((m) => m(ctx))
  )
  const project = services.projects.create(root, 'repo')
  const chat = services.chats.create({
    projectId: project.id,
    title: 'Original',
    color: '#abc',
    combo: 'fake/combo',
    permissionMode: 'allow-all',
    maxIterations: 30,
    settings: { reasoning: 'high', summarizerModel: 'sum/model' }
  })
  return { ctx, services, events, router, h, chat }
}

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condição não atingida')
}

const seed = (env: Env): void => {
  env.services.messages.append(env.chat.id, { role: 'user', content: 'crie o módulo X' })
  env.services.messages.append(env.chat.id, { role: 'assistant', content: 'módulo X criado' })
}

describe('groups.*', () => {
  it('CRUD de grupos; delete deixa os chats sem grupo; chats.list traz groupId', async () => {
    const env = await setup(() => undefined)
    const { h, chat } = env
    const g1 = h['groups.create']({ projectId: chat.projectId, name: '  Backend ' }) as Body
    const g2 = h['groups.create']({ projectId: chat.projectId, name: 'UI' }) as Body
    expect(g1).toMatchObject({ name: 'Backend', sortOrder: 0, collapsed: false })
    expect(g2.sortOrder).toBe(1)
    expect(() => h['groups.create']({ projectId: chat.projectId, name: ' ' })).toThrow()
    expect(() => h['groups.create']({ projectId: 'nope', name: 'x' })).toThrow(/Projeto/)

    const up = h['groups.update']({ id: g1.id, name: 'API', collapsed: true, sortOrder: 5 })
    expect(up).toMatchObject({ name: 'API', collapsed: true, sortOrder: 5 })
    expect(() => h['groups.update']({ id: 'nope', name: 'x' })).toThrow(/Grupo/)
    expect((h['groups.list']({ projectId: chat.projectId }) as Body[]).map((g) => g.id)).toEqual([
      g2.id,
      g1.id
    ])

    h['chats.update']({ id: chat.id, groupId: g1.id })
    expect((h['chats.list']({ projectId: chat.projectId }) as Chat[])[0].groupId).toBe(g1.id)
    expect(() => h['chats.update']({ id: chat.id, groupId: 'nope' })).toThrow(/Grupo/)

    expect(h['groups.delete']({ id: g1.id })).toBeNull()
    expect(env.services.chats.get(chat.id)?.groupId).toBeNull()
    expect((h['groups.list']({ projectId: chat.projectId }) as Body[]).map((g) => g.id)).toEqual([
      g2.id
    ])

    h['chats.update']({ id: chat.id, groupId: g2.id })
    h['chats.update']({ id: chat.id, groupId: null })
    expect(env.services.chats.get(chat.id)?.groupId).toBeNull()
  })
})

describe('chats.continue', () => {
  it('cria o chat vinculado, no grupo novo, com o summary como primeira mensagem', async () => {
    const env = await setup((b) => (isSummarize(b) ? text(SUMMARY) : undefined))
    seed(env)
    const created = (await env.h['chats.continue']({ chatId: env.chat.id })) as Chat

    const original = env.services.chats.get(env.chat.id) as Chat
    expect(original.groupId).not.toBeNull()
    const group = env.services.groups.get(original.groupId as string)
    expect(group?.name).toBe('Original')
    expect(created).toMatchObject({
      projectId: env.chat.projectId,
      groupId: original.groupId,
      continuedFromChatId: env.chat.id,
      parentChatId: null,
      title: 'Continuação: Original',
      combo: 'fake/combo',
      permissionMode: 'allow-all',
      maxIterations: 30
    })
    expect(created.settings).toEqual(original.settings)

    const msgs = env.services.messages.list(created.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('summary')
    expect(String(msgs[0].message.content).startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(summaryText(msgs[0])).toBe(SUMMARY)

    // summarizer usou o modelo do chat primeiro e recebeu a conversa original
    const req = env.router.requests.find(isSummarize)
    expect(req.model).toBe('sum/model')
    expect(userText(req)).toContain('crie o módulo X')
    expect(userText(req)).not.toContain('<previous_summary>')

    // o original não é alterado além do grupo
    expect(env.services.messages.list(env.chat.id)).toHaveLength(2)
    expect(env.events.filter((e) => e.type === 'chat_updated')).toHaveLength(2)
  })

  it('mantém o grupo do original e reusa o último summary + mensagens depois dele', async () => {
    const env = await setup((b) => (isSummarize(b) ? text(SUMMARY) : undefined))
    const g = env.services.groups.create(env.chat.projectId, 'G')
    env.services.chats.update(env.chat.id, { groupId: g.id })
    env.services.messages.append(env.chat.id, { role: 'user', content: 'antigo' })
    env.services.messages.markCompacted(env.chat.id, [1])
    env.services.messages.append(
      env.chat.id,
      { role: 'user', content: SUMMARY_PREFIX + 'RESUMO ANTERIOR' },
      { kind: 'summary', modelUsed: 'm' }
    )
    env.services.messages.append(env.chat.id, { role: 'user', content: 'depois do resumo' })

    const created = (await env.h['chats.continue']({ chatId: env.chat.id })) as Chat
    expect(created.groupId).toBe(g.id)
    expect(env.services.groups.list(env.chat.projectId)).toHaveLength(1)
    const req = env.router.requests.find(isSummarize)
    expect(userText(req)).toContain('RESUMO ANTERIOR')
    expect(userText(req)).toContain('depois do resumo')
    expect(userText(req)).not.toContain('antigo')
  })

  it('sem mensagens após o summary, reusa o summary sem chamar o modelo', async () => {
    const env = await setup((b) => (isSummarize(b) ? text(SUMMARY) : undefined))
    env.services.messages.append(
      env.chat.id,
      { role: 'user', content: SUMMARY_PREFIX + SUMMARY },
      { kind: 'summary', modelUsed: 'm' }
    )
    const created = (await env.h['chats.continue']({ chatId: env.chat.id })) as Chat
    expect(env.router.requests).toHaveLength(0)
    expect(summaryText(env.services.messages.list(created.id)[0])).toBe(SUMMARY)
  })

  it('rejeita chat vazio, inexistente e subagente', async () => {
    const env = await setup(() => undefined)
    await expect(env.h['chats.continue']({ chatId: env.chat.id }) as Promise<Chat>).rejects.toThrow(
      /vazio/
    )
    await expect(env.h['chats.continue']({ chatId: 'nope' }) as Promise<Chat>).rejects.toThrow(
      /não encontrado/
    )
    const child = env.services.chats.create({
      projectId: env.chat.projectId,
      title: 'filho',
      color: '#abc',
      combo: 'fake/combo',
      parentChatId: env.chat.id
    })
    await expect(env.h['chats.continue']({ chatId: child.id }) as Promise<Chat>).rejects.toThrow(
      /Subagentes/
    )
  })

  it('subagentes funcionam no chat continuado (task não bloqueado)', async () => {
    const env = await setup((b) => {
      if (isSummarize(b)) return text(SUMMARY)
      if (firstUser(b) === 'CHILD') return text('resultado do filho')
      return toolCount(b) === 0
        ? calls(['t1', 'task', { agent: 'general', description: 'pesquisa', prompt: 'CHILD' }])
        : text('pronto')
    })
    seed(env)
    const cont = (await env.h['chats.continue']({ chatId: env.chat.id })) as Chat
    await env.services.engine.send(cont.id, 'vai', [])
    await until(() =>
      env.events.some(
        (e) => (e.type === 'turn_finished' || e.type === 'turn_error') && e.chatId === cont.id
      )
    )

    const results = env.services.messages
      .list(cont.id)
      .filter((m) => m.message.role === 'tool')
      .map((m) => String(m.message.content))
    expect(results).toEqual(['resultado do filho'])
    const children = env.services.chats.children(cont.id)
    expect(children).toHaveLength(1)
    expect(children[0].parentChatId).toBe(cont.id)
    // o request do chat continuado leva o summary e a ferramenta task
    const req = env.router.requests.find((b) => !isSummarize(b) && firstUser(b) !== 'CHILD')
    expect(firstUser(req).startsWith(SUMMARY_PREFIX)).toBe(true)
    expect((req.tools ?? []).map((t: Body) => t.function.name)).toContain('task')
  })
})
