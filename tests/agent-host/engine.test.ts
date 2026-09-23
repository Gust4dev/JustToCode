import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type Chat,
  type PermissionMode
} from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb, type Db } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { createServices, type Services } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { capToolOutput } from '../../src/agent-host/engine/toolOutput'
import { buildSystemPrompt } from '../../src/agent-host/engine/systemPrompt'
import { killTree } from '../../src/agent-host/tools/processTree'
import { chunk, startFakeRouter, type FakeRouter, type FakeTurn } from '../helpers/fakeRouter'

const isWin = process.platform === 'win32'
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const spawnedPids = new Set<number>()
const routers: FakeRouter[] = []

interface Env {
  root: string
  db: Db
  services: Services
  events: EngineEvent[]
  router: FakeRouter
  cfg: AppConfig
  chat: Chat
  projectId: string
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function setup(
  turns: FakeTurn[],
  o: { mode?: PermissionMode; cfg?: Partial<AppConfig>; models?: unknown[] } = {}
): Promise<Env> {
  const base = mkdtempSync(join(tmpdir(), 'jtc-eng-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'a.txt'), 'alpha content\n')
  writeFileSync(join(root, 'b.txt'), 'beta content\n')
  writeFileSync(
    join(root, 'big.txt'),
    Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n') + '\n'
  )
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')

  const router = await startFakeRouter(turns, o.models)
  routers.push(router)
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    routerBaseUrl: router.url,
    routerApiKey: 'sk-test',
    defaultCombo: 'fake/combo',
    // nunca lê o banco real do 9router do usuário
    routerDbPath: join(base, 'no-router.sqlite'),
    // nunca lê instruções/skills/commands reais do usuário
    instructionFiles: [],
    skillRoots: [],
    commandRoots: [],
    agentRoots: [],
    pluginRoots: [],
    ...o.cfg
  }
  const db = openDb(join(base, 'db.sqlite'))
  const blobs = new BlobStore(join(base, 'blobs'))
  const events: EngineEvent[] = []
  const services = createServices(
    { db, blobs, emit: (e) => events.push(e) },
    { model: createOpenAiClient(() => cfg), getConfig: () => cfg, retryDelaysMs: [20, 40] }
  )
  const project = services.projects.create(root, 'repo')
  const chat = services.chats.create({
    projectId: project.id,
    title: 't',
    color: '#fff',
    combo: 'fake/combo',
    permissionMode: o.mode ?? 'allow-all'
  })
  return { root, db, services, events, router, cfg, chat, projectId: project.id }
}

async function waitFor<T extends EngineEvent>(
  events: EngineEvent[],
  pred: (e: EngineEvent) => e is T,
  ms = 15_000
): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = events.find(pred)
    if (found) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('evento não chegou; recebidos: ' + events.map((e) => e.type).join(', '))
}

const isEnd = (
  e: EngineEvent
): e is Extract<EngineEvent, { type: 'turn_finished' | 'turn_error' }> =>
  e.type === 'turn_finished' || e.type === 'turn_error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolMessages = (req: any): { tool_call_id: string; content: string }[] =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req.messages.filter((m: any) => m.role === 'tool')

const textTurn = (t: string): FakeTurn => ({
  chunks: [chunk.text(t), chunk.finish('stop'), chunk.usage(100, 5)]
})
const toolTurn = (...calls: [string, string, string][]): FakeTurn => ({
  chunks: [
    ...calls.map(([id, name, args], i) => chunk.toolCall(i, id, name, args)),
    chunk.finish('tool_calls')
  ]
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

afterAll(async () => {
  for (const pid of spawnedPids) await killTree(pid)
})

describe('capToolOutput / systemPrompt', () => {
  it('mantém cabeça 60% + cauda 40% e cita o id', () => {
    const text = 'A'.repeat(600) + 'B'.repeat(400) + 'C'.repeat(1000)
    const r = capToolOutput(text, 1000, 'tc-1')
    expect(r.truncated).toBe(true)
    expect(r.content.startsWith('A'.repeat(600))).toBe(true)
    expect(r.content.endsWith('C'.repeat(400))).toBe(true)
    expect(r.content).toContain('tc-1')
    expect(capToolOutput('curto', 1000, 'x')).toEqual({ content: 'curto', truncated: false })
  })
  it('system prompt fala de PowerShell e da raiz', () => {
    const s = buildSystemPrompt({ projectRoot: 'C:\\p', shell: 'pwsh', date: '2026-09-22' })
    expect(s).toContain('C:\\p')
    expect(s).toContain('PowerShell')
    expect(s).toContain('read_file')
  })
})

describe('agent engine', () => {
  it('texto simples: grava mensagens e emite eventos na ordem', async () => {
    const env = await setup([
      {
        chunks: [chunk.text('Olá'), chunk.text(' mundo'), chunk.finish('stop'), chunk.usage(50, 2)]
      }
    ])
    const { messageId } = await env.services.engine.send(env.chat.id, 'oi', [])
    expect(messageId).toBeTruthy()
    await waitFor(env.events, isEnd)
    const types = env.events
      .map((e) => e.type)
      .filter((t) => ['message_added', 'turn_started', 'text_delta', 'turn_finished'].includes(t))
    expect(types).toEqual([
      'message_added',
      'turn_started',
      'text_delta',
      'text_delta',
      'message_added',
      'turn_finished'
    ])
    const msgs = env.services.messages.list(env.chat.id)
    expect(msgs.map((m) => m.message)).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'Olá mundo' }
    ])
    expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')
    expect(env.services.engine.isRunning(env.chat.id)).toBe(false)
    const req = env.services.requests.list(env.chat.id)
    expect(req).toHaveLength(1)
    expect(req[0]).toMatchObject({
      promptTokens: 50,
      completionTokens: 2,
      modelReported: 'fake/model'
    })
    expect(env.router.requests[0].messages[0].role).toBe('system')
    const ctxEv = env.events.filter((e) => e.type === 'context_updated')
    expect(ctxEv.length).toBeGreaterThanOrEqual(2)
    expect(env.services.engine.context(env.chat.id).reportedTokens).toBe(52)
  })

  it('duas read_file paralelas → duas mensagens tool na segunda chamada', async () => {
    const env = await setup([
      {
        chunks: [
          chunk.toolCall(0, 'call_a', 'read_file', '{"path":'),
          chunk.toolCall(1, 'call_b', 'read_file', '{"path":"b'),
          chunk.toolCall(0, '', '', '"a.txt"}'),
          chunk.toolCall(1, '', '', '.txt"}'),
          chunk.finish('tool_calls')
        ]
      },
      textTurn('li os dois')
    ])
    await env.services.engine.send(env.chat.id, 'leia', [])
    const end = await waitFor(env.events, isEnd)
    expect(end.type).toBe('turn_finished')
    expect(env.router.requests).toHaveLength(2)
    const tools = toolMessages(env.router.requests[1])
    expect(tools.map((t) => t.tool_call_id)).toEqual(['call_a', 'call_b'])
    expect(tools[0].content).toContain('alpha content')
    expect(tools[1].content).toContain('beta content')
    const records = env.services.toolCalls.listByChat(env.chat.id)
    expect(records.map((r) => r.status)).toEqual(['done', 'done'])
    const running = env.events.filter(
      (e) => e.type === 'tool_call_started' && e.toolCall.status === 'running'
    )
    expect(running).toHaveLength(2)
  })

  it('edit_file gera file_changes', async () => {
    const env = await setup([
      toolTurn([
        'call_e',
        'edit_file',
        JSON.stringify({ path: 'a.txt', old_string: 'alpha', new_string: 'omega' })
      ]),
      textTurn('feito')
    ])
    await env.services.engine.send(env.chat.id, 'edite', [])
    await waitFor(env.events, isEnd)
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('omega content\n')
    const changes = env.services.fileChanges.listUnreviewed(env.projectId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: 'a.txt', origin: 'tool', chatId: env.chat.id })
    expect(env.events.some((e) => e.type === 'file_touched')).toBe(true)
  })

  it('JSON inválido volta ao modelo como erro e o turno continua', async () => {
    const env = await setup([toolTurn(['call_x', 'read_file', '{bad json']), textTurn('ok')])
    await env.services.engine.send(env.chat.id, 'x', [])
    const end = await waitFor(env.events, isEnd)
    expect(end.type).toBe('turn_finished')
    const tools = toolMessages(env.router.requests[1])
    expect(tools).toHaveLength(1)
    expect(tools[0].content).toContain('Invalid JSON')
    expect(env.services.toolCalls.listByChat(env.chat.id)[0].status).toBe('error')
  })

  it('modo ask: permission_requested → deny → "User denied this action."', async () => {
    const env = await setup(
      [
        toolTurn([
          'call_e',
          'edit_file',
          JSON.stringify({ path: 'a.txt', old_string: 'alpha', new_string: 'omega' })
        ]),
        textTurn('entendido')
      ],
      { mode: 'ask' }
    )
    await env.services.engine.send(env.chat.id, 'edite', [])
    const req = await waitFor(
      env.events,
      (e): e is Extract<EngineEvent, { type: 'permission_requested' }> =>
        e.type === 'permission_requested'
    )
    expect(env.services.chats.get(env.chat.id)?.status).toBe('waiting_approval')
    expect(env.services.toolCalls.listByChat(env.chat.id)[0].status).toBe('awaiting_approval')
    // o card precisa ver o status atualizado (upsert por id via tool_call_started)
    const started = env.events.filter((e) => e.type === 'tool_call_started')
    expect(started.map((e) => e.toolCall.status)).toEqual(['pending', 'awaiting_approval'])
    env.services.gate.resolve(req.approval.id, 'deny', false)
    const end = await waitFor(env.events, isEnd)
    expect(end.type).toBe('turn_finished')
    expect(toolMessages(env.router.requests[1])[0].content).toBe('User denied this action.')
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('alpha content\n')
    expect(env.services.toolCalls.listByChat(env.chat.id)[0].status).toBe('denied')
  })

  it('janela efetiva vem de /models e recarrega quando a config muda', async () => {
    const env = await setup([textTurn('um')], {
      models: [{ id: 'fake/combo', owned_by: 'openai', context_length: 200000 }]
    })
    await env.services.engine.send(env.chat.id, 'oi', [])
    await waitFor(env.events, isEnd)
    expect(env.services.requests.list(env.chat.id)[0].effectiveWindow).toBe(200000)
    const ctxEv = env.events.filter((e) => e.type === 'context_updated')
    expect(ctxEv.every((e) => e.context.effectiveWindow === 200000)).toBe(true)
    expect(ctxEv[0].context.limitingModel).toBe('fake/combo')
    expect(env.services.engine.context(env.chat.id).effectiveWindow).toBe(200000)

    // troca de router (config nova) → nova lista de modelos
    const r2 = await startFakeRouter(
      [textTurn('dois')],
      [{ id: 'fake/combo', owned_by: 'openai', context_length: 64000 }]
    )
    routers.push(r2)
    env.cfg.routerBaseUrl = r2.url
    env.events.length = 0
    await env.services.engine.send(env.chat.id, 'de novo', [])
    await waitFor(env.events, isEnd)
    expect(env.services.requests.list(env.chat.id)[1].effectiveWindow).toBe(64000)
  })

  it('provider_switched só quando havia modelo anterior e ele muda', async () => {
    const env = await setup([
      textTurn('um'),
      { chunks: [chunk.text('dois', 'outro/model'), chunk.finish('stop')] }
    ])
    await env.services.engine.send(env.chat.id, 'oi', [])
    await waitFor(env.events, isEnd)
    expect(env.events.some((e) => e.type === 'provider_switched')).toBe(false)
    env.events.length = 0
    await env.services.engine.send(env.chat.id, 'de novo', [])
    await waitFor(env.events, isEnd)
    const sw = env.events.filter((e) => e.type === 'provider_switched')
    expect(sw).toEqual([
      { type: 'provider_switched', chatId: env.chat.id, from: 'fake/model', to: 'outro/model' }
    ])
  })

  it('503 seguido de sucesso → retry', async () => {
    const env = await setup([
      { status: 503, errorBody: { error: { message: 'ocupado', type: 'server_error' } } },
      textTurn('voltei')
    ])
    await env.services.engine.send(env.chat.id, 'oi', [])
    const end = await waitFor(env.events, isEnd)
    expect(end.type).toBe('turn_finished')
    expect(env.router.requests).toHaveLength(2)
    const reqs = env.services.requests.list(env.chat.id)
    expect(reqs).toHaveLength(2)
    expect(reqs[0].error).toBeTruthy()
    expect(reqs[1].error).toBeNull()
  })

  it('401 → turn_error AUTH', async () => {
    const env = await setup([
      { status: 401, errorBody: { error: { message: 'bad key', code: 'invalid_api_key' } } }
    ])
    await env.services.engine.send(env.chat.id, 'oi', [])
    const end = await waitFor(env.events, isEnd)
    expect(end).toMatchObject({
      type: 'turn_error',
      code: 'AUTH',
      message: 'Configure a chave do 9router nas configurações'
    })
    expect(env.router.requests).toHaveLength(1)
    expect(env.services.chats.get(env.chat.id)?.status).toBe('error')
  })

  it('send com o chat ocupado → CHAT_BUSY', async () => {
    const env = await setup([{ chunks: [chunk.text('pensando...')], hold: true }])
    await env.services.engine.send(env.chat.id, 'um', [])
    await expect(env.services.engine.send(env.chat.id, 'dois', [])).rejects.toMatchObject({
      code: 'CHAT_BUSY'
    })
    await waitFor(env.events, (e): e is EngineEvent => e.type === 'text_delta')
    env.services.engine.cancel(env.chat.id)
    const end = await waitFor(env.events, isEnd)
    expect(end).toMatchObject({ type: 'turn_error', code: 'CANCELLED' })
    expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')
    // texto parcial fica gravado
    expect(env.services.messages.list(env.chat.id).map((m) => m.message.role)).toEqual([
      'user',
      'assistant'
    ])
  })

  it('imagem anexada → request com data URL', async () => {
    const env = await setup([textTurn('vi a imagem')])
    await env.services.engine.send(env.chat.id, 'olha', [
      { name: 'p.png', mime: 'image/png', dataBase64: PNG_1x1 }
    ])
    await waitFor(env.events, isEnd)
    const user = env.router.requests[0].messages[1]
    expect(user.role).toBe('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = user.content.find((p: any) => p.type === 'image_url')
    expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    const stored = env.services.messages.list(env.chat.id)[0]
    expect(stored.attachments).toHaveLength(1)
    expect(stored.attachments[0]).toMatchObject({
      kind: 'image',
      width: 1,
      height: 1,
      name: 'p.png'
    })
    const payload = env.services.requests.get(env.services.requests.list(env.chat.id)[0].id)
    expect(payload?.payloadBlobHash).toBeTruthy()
  })

  it('saída grande é truncada e read_tool_output recupera o conteúdo inteiro', async () => {
    const env = await setup(
      [
        toolTurn(['call_big', 'read_file', '{"path":"big.txt"}']),
        toolTurn(['call_r', 'read_tool_output', '{"id":"call_big"}']),
        textTurn('li tudo')
      ],
      { cfg: { toolOutputMaxChars: 500 } }
    )
    await env.services.engine.send(env.chat.id, 'leia big', [])
    const end = await waitFor(env.events, isEnd)
    expect(end.type).toBe('turn_finished')
    const first = toolMessages(env.router.requests[1])[0].content
    expect(first).toContain('characters omitted')
    expect(first).toContain('read_tool_output')
    expect(first.length).toBeLessThan(800)
    const full = toolMessages(env.router.requests[2])[1].content
    expect(full).not.toContain('characters omitted')
    expect(full).toContain('line 1 ')
    expect(full).toContain('line 100 ')
    expect(full).toContain('line 200 ')
    const [big] = env.services.toolCalls.listByChat(env.chat.id)
    expect(big.outputTruncated).toBe(true)
  })

  it('inicialização marca chats running/waiting_approval como interrupted', async () => {
    const env = await setup([])
    env.services.chats.setStatus(env.chat.id, 'running')
    const other = env.services.chats.create({
      projectId: env.projectId,
      title: 'w',
      color: '#000',
      combo: 'x'
    })
    env.services.chats.setStatus(other.id, 'waiting_approval')
    const again = createServices({
      db: env.db,
      blobs: new BlobStore(join(env.root, '..', 'b2')),
      emit: () => {}
    })
    expect(again.interrupted.sort()).toEqual([env.chat.id, other.id].sort())
    expect(env.services.chats.get(env.chat.id)?.status).toBe('interrupted')
    expect(env.services.chats.get(other.id)?.status).toBe('interrupted')
  })

  it.skipIf(!isWin)(
    'cancel durante shell com Start-Sleep 30 → termina em < 3 s e sem filho vivo',
    async () => {
      const cmd =
        'Write-Output "SHELL:$PID"; ' +
        "$p = Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru; " +
        'Write-Output "CHILD:$($p.Id)"; Start-Sleep 30'
      const env = await setup([toolTurn(['call_s', 'shell', JSON.stringify({ command: cmd })])])
      await env.services.engine.send(env.chat.id, 'rode', [])
      const pids: number[] = []
      const end0 = Date.now() + 20_000
      while (pids.length < 2 && Date.now() < end0) {
        pids.length = 0
        const out = env.events.map((e) => (e.type === 'tool_output_delta' ? e.delta : '')).join('')
        for (const m of out.matchAll(/(?:SHELL|CHILD):(\d+)\r?\n/g)) pids.push(Number(m[1]))
        await new Promise((r) => setTimeout(r, 50))
      }
      pids.forEach((p) => spawnedPids.add(p))
      expect(pids).toHaveLength(2)

      const t0 = Date.now()
      env.services.engine.cancel(env.chat.id)
      const end = await waitFor(env.events, isEnd, 10_000)
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(end).toMatchObject({ type: 'turn_error', code: 'CANCELLED' })
      expect(env.services.chats.get(env.chat.id)?.status).toBe('idle')
      expect(env.services.toolCalls.listByChat(env.chat.id)[0].status).toBe('cancelled')
      const deadline = Date.now() + 5000
      while (pids.some(isAlive) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(pids.filter(isAlive)).toEqual([])
      // histórico continua válido: a tool call tem mensagem tool correspondente
      const roles = env.services.messages.list(env.chat.id).map((m) => m.message.role)
      expect(roles).toEqual(['user', 'assistant', 'tool'])
    },
    40_000
  )
})
