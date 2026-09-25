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
import { withReasoning } from '../../src/agent-host/model/reasoning'
import { summarizerModels } from '../../src/agent-host/context/compaction'
import {
  interpretRuleResponse,
  parseRule,
  RULE_PARSE_SYSTEM
} from '../../src/agent-host/engine/ruleParse'
import { ruleHandlers } from '../../src/agent-host/handlers/rules'
import { chunk, startFakeRouter, type FakeRouter, type FakeTurn } from '../helpers/fakeRouter'

const routers: FakeRouter[] = []
afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any

const MODELS = [{ id: 'fake/combo' }, { id: 'light/combo' }, { id: 'sub/combo' }]

const text = (t: string, extra: Record<string, unknown>[] = []): FakeTurn => ({
  chunks: [chunk.text(t), ...extra, chunk.finish('stop'), chunk.usage(10, 2)]
})

interface Env {
  services: Services
  events: EngineEvent[]
  router: FakeRouter
  cfg: AppConfig
  chat: Chat
}

async function setup(respond: (b: Body) => FakeTurn | undefined): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-reason-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
  writeFileSync(join(root, 'a.txt'), 'alpha\n')
  const router = await startFakeRouter(respond, MODELS)
  routers.push(router)
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    routerBaseUrl: router.url,
    routerApiKey: 'sk-test',
    defaultCombo: 'fake/combo',
    lightCombo: 'light/combo',
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
    title: 'chat',
    color: '#abc',
    combo: 'fake/combo',
    permissionMode: 'allow-all'
  })
  return { services, events, router, cfg, chat }
}

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condição não atingida')
}

const ended = (env: Env, chatId = env.chat.id): boolean =>
  env.events.some(
    (e) => (e.type === 'turn_finished' || e.type === 'turn_error') && e.chatId === chatId
  )

const chatRequests = (env: Env): Body[] =>
  env.router.requests.filter((b: Body) => !String(b.messages?.[0]?.content).startsWith('You write'))

describe('withReasoning', () => {
  const req = { model: 'c', messages: [], tools: [] }
  it('sem nível não mexe no request', () => {
    expect(withReasoning(req, null, 'both')).toBe(req)
  })
  it('param / suffix / both', () => {
    expect(withReasoning(req, 'low', 'param')).toEqual({ ...req, reasoning: 'low' })
    expect(withReasoning(req, 'low', 'suffix')).toEqual({ ...req, model: 'c(low)' })
    expect(withReasoning(req, 'high', 'both')).toEqual({
      ...req,
      model: 'c(high)',
      reasoning: 'high'
    })
  })
})

describe('summarizerModels com ajuste do chat', () => {
  it('o modelo do resumo do chat vem primeiro', () => {
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: 'cfg/sum', lightCombo: 'light' }
    expect(summarizerModels(cfg, 'chat', 'chat/sum')).toEqual([
      'chat/sum',
      'cfg/sum',
      'light',
      'chat'
    ])
    expect(summarizerModels(cfg, 'chat', null)).toEqual(['cfg/sum', 'light', 'chat'])
  })
})

describe('rules.parse', () => {
  it('interpreta resposta válida e valida valores', () => {
    const raw =
      '<think>hmm</think>```json\n{"ruleText":"Responda em português","suggestions":[' +
      '{"key":"reasoning","value":"high"},{"key":"maxIterations","value":"80"},' +
      '{"key":"tokenBudget","value":-5},{"key":"reasoning","value":"low"},' +
      '{"key":"permissionMode","value":"allow-all"},{"key":"subagentReasoning","value":"max"}]}\n```'
    const r = interpretRuleResponse('orig', raw, ['a'])
    expect(r.ruleText).toBe('Responda em português')
    expect(r.suggestions).toEqual([
      { key: 'reasoning', value: 'high', label: 'Reasoning do chat: alto' },
      { key: 'maxIterations', value: 80, label: 'Limite de iterações: 80' }
    ])
  })

  it('resposta inválida cai no texto original sem sugestões', () => {
    expect(interpretRuleResponse('orig', 'não é json', [])).toEqual({
      ruleText: 'orig',
      suggestions: []
    })
    expect(interpretRuleResponse('orig', '{"suggestions":[]}', [])).toEqual({
      ruleText: 'orig',
      suggestions: []
    })
    expect(interpretRuleResponse('orig', '{"ruleText":"","suggestions":[]}', [])).toEqual({
      ruleText: 'orig',
      suggestions: []
    })
  })

  it('handler usa o combo leve e descarta combo inexistente', async () => {
    const env = await setup((b) => {
      if (b.messages[0].content !== RULE_PARSE_SYSTEM) return undefined
      return text(
        JSON.stringify({
          ruleText: 'Sempre rode os testes',
          suggestions: [
            { key: 'subagentCombo', value: 'nao/existe' },
            { key: 'summarizerModel', value: 'sub/combo' },
            { key: 'subagentReasoning', value: 'medium' },
            { key: 'tokenBudget', value: null }
          ]
        })
      )
    })
    const h = ruleHandlers({
      model: env.services.model,
      chats: env.services.chats,
      getConfig: () => env.cfg
    })({} as HostContext)
    const r = await h['rules.parse']({ chatId: env.chat.id, text: 'rode testes; resumo com sub' })
    expect(env.router.requests[0].model).toBe('light/combo')
    expect(env.router.requests[0].messages[1].content).toContain('sub/combo')
    expect(r).toEqual({
      ruleText: 'Sempre rode os testes',
      suggestions: [
        { key: 'summarizerModel', value: 'sub/combo', label: 'Modelo do resumo: sub/combo' },
        {
          key: 'subagentReasoning',
          value: 'medium',
          label: 'Reasoning dos subagents: médio'
        },
        { key: 'tokenBudget', value: null, label: 'Orçamento: sem limite' }
      ]
    })
    await expect(h['rules.parse']({ chatId: 'x', text: 'a' })).rejects.toThrow()
  })

  it('falha do modelo cai no texto original', async () => {
    const env = await setup(() => ({ status: 500 }))
    const r = await parseRule(
      { model: env.services.model, getConfig: () => env.cfg },
      env.chat,
      'use reasoning alto'
    )
    expect(r).toEqual({ ruleText: 'use reasoning alto', suggestions: [] })
  })
})

describe('reasoning do chat no turno', () => {
  it('request leva reasoning_effort e confirma com reasoning_delta', async () => {
    const env = await setup(() =>
      text('ok', [
        { model: 'fake/model', choices: [{ index: 0, delta: { reasoning_content: 'pensando' } }] }
      ])
    )
    env.services.chats.update(env.chat.id, { settings: { reasoning: 'high' } })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await until(() => ended(env))
    const req = chatRequests(env)[0]
    expect(req.reasoning_effort).toBe('high')
    expect(req.model).toBe('fake/combo')
    const st = env.events.filter((e) => e.type === 'reasoning_status')
    expect(st).toHaveLength(1)
    expect(st[0]).toMatchObject({ chatId: env.chat.id, requested: 'high', confirmed: true })
  })

  it('confirma por reasoning_tokens > 0', async () => {
    const env = await setup(() => ({
      chunks: [
        chunk.text('ok'),
        chunk.finish('stop'),
        {
          model: 'fake/model',
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: { reasoning_tokens: 3 }
          }
        }
      ]
    }))
    env.services.chats.update(env.chat.id, { settings: { reasoning: 'low' } })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await until(() => ended(env))
    expect(env.events.find((e) => e.type === 'reasoning_status')).toMatchObject({
      requested: 'low',
      confirmed: true
    })
  })

  it('sem evidência de reasoning: não confirmado; estilo suffix usa modelo(level)', async () => {
    const env = await setup(() => text('ok'))
    env.cfg.reasoningStyle = 'suffix'
    env.services.chats.update(env.chat.id, { settings: { reasoning: 'medium' } })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await until(() => ended(env))
    const req = chatRequests(env)[0]
    expect(req.model).toBe('fake/combo(medium)')
    expect(req.reasoning_effort).toBeUndefined()
    expect(env.events.find((e) => e.type === 'reasoning_status')).toMatchObject({
      requested: 'medium',
      confirmed: false
    })
  })

  it('estilo both manda os dois; sem reasoning no chat não manda nada', async () => {
    const env = await setup(() => text('ok'))
    await env.services.engine.send(env.chat.id, 'oi', [])
    await until(() => ended(env))
    expect(chatRequests(env)[0].reasoning_effort).toBeUndefined()
    expect(env.events.some((e) => e.type === 'reasoning_status')).toBe(false)

    env.cfg.reasoningStyle = 'both'
    env.services.chats.update(env.chat.id, { settings: { reasoning: 'low' } })
    env.events.length = 0
    await env.services.engine.send(env.chat.id, 'de novo', [])
    await until(() => ended(env))
    const req = chatRequests(env).pop()
    expect(req.model).toBe('fake/combo(low)')
    expect(req.reasoning_effort).toBe('low')
  })
})

describe('subagentes usam os ajustes do chat', () => {
  it('combo e reasoning dos subagentes', async () => {
    const env = await setup((b) => {
      const first = b.messages.find((m: Body) => m.role === 'user')?.content
      if (first === 'CHILD') return text('feito pelo filho')
      const done = b.messages.some((m: Body) => m.role === 'tool')
      if (done) return text('fim')
      return {
        chunks: [
          chunk.toolCall(
            0,
            't1',
            'task',
            JSON.stringify({ agent: 'general', description: 'x', prompt: 'CHILD' })
          ),
          chunk.finish('tool_calls')
        ]
      }
    })
    env.services.chats.update(env.chat.id, {
      settings: { reasoning: 'low', subagentCombo: 'sub/combo', subagentReasoning: 'high' }
    })
    await env.services.engine.send(env.chat.id, 'PAI', [])
    await until(() => ended(env))
    const childReq = env.router.requests.find(
      (b: Body) => b.messages.find((m: Body) => m.role === 'user')?.content === 'CHILD'
    )
    expect(childReq.model).toBe('sub/combo')
    expect(childReq.reasoning_effort).toBe('high')
    const parentReq = env.router.requests.find(
      (b: Body) => b.messages.find((m: Body) => m.role === 'user')?.content === 'PAI'
    )
    expect(parentReq.model).toBe('fake/combo')
    expect(parentReq.reasoning_effort).toBe('low')
    const started = env.events.find((e) => e.type === 'subagent_started')
    const child = env.services.chats.get(
      (started as Extract<EngineEvent, { type: 'subagent_started' }>).childChatId
    )
    expect(child?.combo).toBe('sub/combo')
    expect(child?.settings.reasoning).toBe('high')
  })
})
