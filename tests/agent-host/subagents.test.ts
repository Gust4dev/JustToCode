import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type Chat } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import type { HostContext } from '../../src/agent-host/context'
import { createServices, type Services } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { chatHandlers } from '../../src/agent-host/handlers/chats'
import { ecosystemHandlers } from '../../src/agent-host/handlers/ecosystem'
import { availableAgents, discoverAgents, filterTools } from '../../src/agent-host/ecosystem/agents'
import { PermissionRuleRepo } from '../../src/agent-host/repo/permissionRules'
import { chunk, startFakeRouter, type FakeRouter, type FakeTurn } from '../helpers/fakeRouter'

const routers: FakeRouter[] = []

afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

interface Env {
  root: string
  ctx: HostContext
  services: Services
  events: EngineEvent[]
  router: FakeRouter
  cfg: AppConfig
  chat: Chat
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any

/** Primeira mensagem do usuário do request (identifica o chat: pai ou filho). */
const firstUser = (b: Body): string => {
  const m = b.messages.find((x: Body) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : ''
}
const toolCount = (b: Body): number => b.messages.filter((x: Body) => x.role === 'tool').length
const toolNames = (b: Body): string[] => (b.tools ?? []).map((t: Body) => t.function.name).sort()
const systemOf = (b: Body): string => b.messages[0].content

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

async function setup(
  respond: (b: Body) => FakeTurn | undefined,
  prepare?: (root: string) => void
): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-sub-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'a.txt'), 'alpha\n')
  prepare?.(root)
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
    pluginRoots: []
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
  const project = services.projects.create(root, 'repo')
  const chat = services.chats.create({
    projectId: project.id,
    title: 'pai',
    color: '#abc',
    combo: 'fake/combo',
    permissionMode: 'allow-all'
  })
  return { root, ctx, services, events, router, cfg, chat }
}

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condição não atingida')
}

const parentEnded = (env: Env): boolean =>
  env.events.some(
    (e) => (e.type === 'turn_finished' || e.type === 'turn_error') && e.chatId === env.chat.id
  )

const toolResults = (env: Env, chatId: string): string[] =>
  env.services.messages
    .list(chatId)
    .filter((m) => m.message.role === 'tool')
    .map((m) => String(m.message.content))

describe('ecosystem/agents', () => {
  it('descobre definições, o projeto vence o global e o general é implícito', () => {
    const base = mkdtempSync(join(tmpdir(), 'jtc-agents-'))
    const global = join(base, 'global')
    const project = join(base, 'proj')
    mkdirSync(global)
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
    writeFileSync(
      join(global, 'reviewer.md'),
      '---\nname: reviewer\ndescription: global\ntools: Read, Grep\n---\nbody'
    )
    writeFileSync(
      join(project, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: projeto\ntools:\n  - read_file\ncombo: x/y\n---\nbody'
    )
    writeFileSync(join(global, 'other.md'), '---\ndescription: sem nome\n---\n')
    const defs = discoverAgents(project, [global])
    expect(defs.map((d) => d.name)).toEqual(['other', 'reviewer'])
    const reviewer = defs.find((d) => d.name === 'reviewer')
    expect(reviewer).toMatchObject({
      description: 'projeto',
      tools: ['read_file'],
      combo: 'x/y',
      scope: 'project'
    })
    expect(defs.find((d) => d.name === 'other')?.tools).toBeNull()
    expect(availableAgents(project, [global]).map((d) => d.name)).toEqual([
      'general',
      'other',
      'reviewer'
    ])
    expect(availableAgents(join(base, 'vazio'), []).map((d) => d.name)).toEqual(['general'])
    // nomes do Claude Code viram as ferramentas do JustToCode
    const tools = ['read_file', 'grep', 'shell', 'edit_file'].map((name) => ({ name }))
    expect(filterTools(tools, ['Read', 'Grep']).map((t) => t.name)).toEqual(['read_file', 'grep'])
    expect(filterTools(tools, null)).toHaveLength(4)
  })
})

describe('subagents', () => {
  it('subagente implícito executa, devolve o texto e não tem a ferramenta task', async () => {
    const env = await setup((b) => {
      if (firstUser(b) === 'CHILD') return text('resultado do filho')
      return toolCount(b) === 0
        ? calls(['t1', 'task', { agent: 'general', description: 'pesquisa', prompt: 'CHILD' }])
        : text('pronto')
    })
    await env.services.engine.send(env.chat.id, 'vai', [])
    await until(() => parentEnded(env))

    expect(toolResults(env, env.chat.id)).toEqual(['resultado do filho'])
    const children = env.services.chats.children(env.chat.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      parentChatId: env.chat.id,
      agentName: 'general',
      title: 'pesquisa',
      color: '#abc',
      combo: 'fake/combo',
      permissionMode: 'allow-all',
      status: 'idle'
    })
    // filhos não aparecem na lista de nível superior
    expect(env.services.chats.listByProject(env.chat.projectId).map((c) => c.id)).toEqual([
      env.chat.id
    ])

    const parentReq = env.router.requests.find((b) => firstUser(b) === 'vai')
    const childReq = env.router.requests.find((b) => firstUser(b) === 'CHILD')
    expect(toolNames(parentReq)).toContain('task')
    expect(toolNames(childReq)).not.toContain('task')
    expect(toolNames(childReq)).toContain('read_file')
    // sem definições além do general: sem seção de subagentes
    expect(systemOf(parentReq)).not.toContain('# Subagents')

    const started = env.events.find((e) => e.type === 'subagent_started')
    const finished = env.events.find((e) => e.type === 'subagent_finished')
    const taskCall = env.services.toolCalls.listByChat(env.chat.id)[0]
    expect(started).toMatchObject({
      chatId: env.chat.id,
      childChatId: children[0].id,
      agentName: 'general',
      toolCallId: taskCall.id
    })
    expect(finished).toMatchObject({ chatId: env.chat.id, childChatId: children[0].id })
    expect(taskCall).toMatchObject({ name: 'task', status: 'done' })
  })

  it('duas task na mesma resposta rodam em paralelo; o router responde conforme o chat', async () => {
    const env = await setup((b) => {
      const u = firstUser(b)
      if (u === 'A' || u === 'B') {
        // cada filho faz uma leitura antes de responder
        return toolCount(b) === 0
          ? calls([`r-${u}`, 'read_file', { path: 'a.txt' }])
          : text(`resposta ${u}`)
      }
      return toolCount(b) === 0
        ? calls(
            ['t1', 'task', { agent: 'general', description: 'a', prompt: 'A' }],
            ['t2', 'task', { agent: 'general', description: 'b', prompt: 'B' }]
          )
        : text('fim')
    })
    await env.services.engine.send(env.chat.id, 'dois', [])
    await until(() => parentEnded(env))

    expect(toolResults(env, env.chat.id)).toEqual(['resposta A', 'resposta B'])
    const order = env.events
      .filter((e) => e.type === 'subagent_started' || e.type === 'subagent_finished')
      .map((e) => e.type)
    // paralelo: os dois começam antes de qualquer um terminar
    expect(order).toEqual([
      'subagent_started',
      'subagent_started',
      'subagent_finished',
      'subagent_finished'
    ])
    expect(env.services.chats.children(env.chat.id).map((c) => c.title)).toEqual(['a', 'b'])
  })

  it('definição com tools e combo filtra as ferramentas; o pai lista os subagentes', async () => {
    const env = await setup(
      (b) => {
        if (firstUser(b) === 'LER') return text('lido')
        return toolCount(b) === 0
          ? calls(['t1', 'task', { agent: 'reader', description: 'ler', prompt: 'LER' }])
          : text('ok')
      },
      (root) => {
        mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
        writeFileSync(
          join(root, '.claude', 'agents', 'reader.md'),
          '---\nname: reader\ndescription: Lê arquivos\ntools: [read_file, Grep]\ncombo: fake/reader\n---\nSó leia, nunca edite.\n'
        )
      }
    )
    await env.services.engine.send(env.chat.id, 'pai', [])
    await until(() => parentEnded(env))

    const parentReq = env.router.requests.find((b) => firstUser(b) === 'pai')
    const childReq = env.router.requests.find((b) => firstUser(b) === 'LER')
    expect(systemOf(parentReq)).toContain('# Subagents')
    expect(systemOf(parentReq)).toContain('- reader: Lê arquivos')
    expect(toolNames(childReq)).toEqual(['grep', 'read_file', 'read_tool_output'])
    expect(childReq.model).toBe('fake/reader')
    expect(systemOf(childReq)).toContain('Só leia, nunca edite.')
    expect(systemOf(childReq)).not.toContain('# Subagents')
    expect(env.services.chats.children(env.chat.id)[0]).toMatchObject({
      agentName: 'reader',
      combo: 'fake/reader'
    })

    const agents = ecosystemHandlers(() => env.cfg)(env.ctx)['ecosystem.agents']({
      projectId: env.chat.projectId
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agents as any[]).map((a) => a.name)).toEqual(['general', 'reader'])
  })

  it('agente desconhecido devolve erro sem criar chat filho', async () => {
    const env = await setup((b) =>
      toolCount(b) === 0
        ? calls(['t1', 'task', { agent: 'nope', description: 'x', prompt: 'X' }])
        : text('ok')
    )
    await env.services.engine.send(env.chat.id, 'vai', [])
    await until(() => parentEnded(env))
    expect(toolResults(env, env.chat.id)[0]).toContain('Unknown agent: nope')
    expect(env.services.chats.children(env.chat.id)).toEqual([])
  })

  it('cancelar o pai cancela o filho em andamento', async () => {
    const env = await setup((b) => {
      if (firstUser(b) === 'LONGO') return { chunks: [chunk.text('pensando...')], hold: true }
      return calls(['t1', 'task', { agent: 'general', description: 'longo', prompt: 'LONGO' }])
    })
    await env.services.engine.send(env.chat.id, 'vai', [])
    await until(() => env.router.requests.some((b) => firstUser(b) === 'LONGO'))
    await until(() => env.events.some((e) => e.type === 'text_delta' && e.chatId !== env.chat.id))
    const child = env.services.chats.children(env.chat.id)[0]
    expect(env.services.engine.isRunning(child.id)).toBe(true)

    env.services.engine.cancel(env.chat.id)
    await until(() => parentEnded(env))

    expect(env.services.engine.isRunning(child.id)).toBe(false)
    expect(env.services.chats.get(child.id)?.status).toBe('idle')
    expect(
      env.events.some(
        (e) => e.type === 'turn_error' && e.chatId === child.id && e.code === 'CANCELLED'
      )
    ).toBe(true)
    expect(env.events.some((e) => e.type === 'subagent_finished')).toBe(true)
    expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')
  })

  it('mudanças do filho ficam atribuídas ao pai, com o toolCallId do filho', async () => {
    const env = await setup((b) => {
      if (firstUser(b) === 'ESCREVA') {
        return toolCount(b) === 0
          ? calls(['w1', 'write_file', { path: 'novo.txt', content: 'oi\n' }])
          : text('escrito')
      }
      return toolCount(b) === 0
        ? calls(['t1', 'task', { agent: 'general', description: 'w', prompt: 'ESCREVA' }])
        : text('ok')
    })
    await env.services.engine.send(env.chat.id, 'vai', [])
    await until(() => parentEnded(env))

    const child = env.services.chats.children(env.chat.id)[0]
    const childCall = env.services.toolCalls
      .listByChat(child.id)
      .find((t) => t.name === 'write_file')
    expect(childCall).toBeTruthy()
    const changes = env.services.fileChanges.forPath(env.chat.projectId, 'novo.txt')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      chatId: env.chat.id,
      origin: 'tool',
      toolCallId: childCall?.id
    })
    expect(env.services.fileChanges.listUnreviewed(env.chat.projectId, child.id)).toEqual([])
  })

  it('chats.children devolve os filhos (e NOT_FOUND para chat inexistente)', async () => {
    const env = await setup(() => undefined)
    const c1 = env.services.chats.create({
      projectId: env.chat.projectId,
      parentChatId: env.chat.id,
      agentName: 'general',
      title: 'f1',
      color: '#abc',
      combo: 'fake/combo'
    })
    const h = chatHandlers(env.ctx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = h['chats.children']({ chatId: env.chat.id }) as any[]
    expect(list.map((c) => c.id)).toEqual([c1.id])
    expect(() => h['chats.children']({ chatId: 'nao-existe' })).toThrow()
  })

  it('"Sempre" em task cria a regra própria de subagentes (e nenhuma regra de shell)', async () => {
    const env = await setup((b) => {
      if (firstUser(b) === 'SUB') return text('feito')
      return toolCount(b) === 0
        ? calls(['t1', 'task', { agent: 'general', description: 'x', prompt: 'SUB' }])
        : text('ok')
    })
    const chat = env.services.chats.update(env.chat.id, { permissionMode: 'ask' })
    const task = env.services.tools.find((t) => t.name === 'task')
    const shell = env.services.tools.find((t) => t.name === 'shell')
    if (!task || !shell) throw new Error('ferramentas ausentes')
    const input = { chat, projectId: chat.projectId, tool: task, args: {}, toolCallId: 'x' }
    expect(env.services.gate.decide(input)).toBe('ask')
    // allow-all continua liberando
    expect(
      env.services.gate.decide({ ...input, chat: { ...chat, permissionMode: 'allow-all' } })
    ).toBe('allow')

    await env.services.engine.send(chat.id, 'vai', [])
    await until(() => env.events.some((e) => e.type === 'permission_requested'))
    const req = env.events.find((e) => e.type === 'permission_requested')
    if (req?.type !== 'permission_requested') throw new Error('sem aprovação')
    expect(req.approval.summary).toBe('subagent general: x')
    env.services.gate.resolve(req.approval.id, 'allow', true)
    await until(() => parentEnded(env))
    expect(toolResults(env, chat.id)).toEqual(['feito'])

    const rules = new PermissionRuleRepo(env.ctx.db)
    expect(rules.list(chat.projectId, 'task').map((r) => r.pattern)).toEqual(['*'])
    expect(rules.list(chat.projectId, 'shell')).toEqual([])
    expect(env.services.gate.decide(input)).toBe('allow')
    // a regra de task não libera comandos de shell
    expect(env.services.gate.decide({ ...input, tool: shell, args: { command: 'npm test' } })).toBe(
      'ask'
    )
  })
})
