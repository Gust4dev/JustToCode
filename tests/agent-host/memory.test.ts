import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { InstructionRepo } from '../../src/agent-host/repo/instructions'
import { MemoryService, type StoredMemoryOrigin } from '../../src/agent-host/memory/memory'
import { createMemoryTools } from '../../src/agent-host/tools/memory'
import type { ToolContext } from '../../src/agent-host/tools/types'
import type { InstructionContext } from '../../src/agent-host/ecosystem/resolver'
import { createServices } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { serviceModules } from '../../src/agent-host/handlers'
import type { HostContext } from '../../src/agent-host/context'
import { chunk, startFakeRouter, type FakeRouter } from '../helpers/fakeRouter'

const routers: FakeRouter[] = []
afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

const base = (): string => mkdtempSync(join(tmpdir(), 'jtc-memory-'))

function unit(): { repo: InstructionRepo; memory: MemoryService } {
  const db = openDb(join(base(), 'db.sqlite'))
  const repo = new InstructionRepo(db)
  return { repo, memory: new MemoryService(repo) }
}

const who = {
  chatId: 'c1',
  projectId: 'p1',
  groupId: 'g1',
  requestId: 'r1',
  thirdParty: [] as string[]
}

const ictx = (cfg: Partial<AppConfig> = {}): InstructionContext => ({
  projectRoot: '.',
  projectId: 'p1',
  groupId: 'g1',
  chatId: 'c1',
  cfg: {
    ...DEFAULT_CONFIG,
    instructionFiles: [],
    skillRoots: [],
    commandRoots: [],
    agentRoots: [],
    pluginRoots: [],
    ruleRoots: [],
    ...cfg
  }
})

describe('MemoryService', () => {
  it('cria e atualiza por id', () => {
    const { memory } = unit()
    const a = memory.save({ ...who, title: 'Estilo', content: 'v1', scope: 'project' })
    expect(a.created).toBe(true)
    expect(a.instruction).toMatchObject({
      kind: 'memory',
      scope: 'project',
      scopeId: 'p1',
      name: 'Estilo',
      body: 'v1',
      source: { type: 'app' }
    })
    const b = memory.save({
      ...who,
      id: a.instruction.id,
      title: 'Estilo 2',
      content: 'v2',
      scope: 'project'
    })
    expect(b.created).toBe(false)
    expect(b.instruction.id).toBe(a.instruction.id)
    expect(b.instruction).toMatchObject({ name: 'Estilo 2', body: 'v2' })
    expect(() =>
      memory.save({ ...who, id: 'nope', title: 'x', content: 'y', scope: 'chat' })
    ).toThrow(/not found/)
  })

  it('título igual no mesmo escopo atualiza; em outro escopo cria', () => {
    const { memory, repo } = unit()
    const a = memory.save({ ...who, title: 'Testes', content: 'v1', scope: 'chat' })
    const b = memory.save({ ...who, title: '  testes ', content: 'v2', scope: 'chat' })
    expect(b.created).toBe(false)
    expect(b.instruction.id).toBe(a.instruction.id)
    const c = memory.save({ ...who, title: 'Testes', content: 'v3', scope: 'global' })
    expect(c.created).toBe(true)
    expect(c.instruction.scopeId).toBeNull()
    expect(repo.list({ kind: 'memory' })).toHaveLength(2)
  })

  it('escopo group sem grupo e conteúdo vazio são erros', () => {
    const { memory } = unit()
    expect(() =>
      memory.save({ ...who, groupId: null, title: 't', content: 'c', scope: 'group' })
    ).toThrow()
    expect(() => memory.save({ ...who, title: 't', content: '  ', scope: 'chat' })).toThrow()
  })

  it('índice: mais recentes primeiro, limitado e só dos escopos aplicáveis', () => {
    const { memory, repo } = unit()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(1_000_000 + i * 1000)
        memory.save({ ...who, title: `m${i}`, content: 'x', scope: 'project' })
      }
    } finally {
      vi.useRealTimers()
    }
    memory.save({ ...who, chatId: 'other', title: 'alheia', content: 'x', scope: 'chat' })
    const s = memory.section(ictx({ memoryIndexMaxLines: 3 }))
    expect(s.startsWith('# Memory')).toBe(true)
    expect(s).toMatch(/Never save secrets/)
    const lines = s.split('\n').filter((l) => l.startsWith('- ['))
    const byName = new Map(repo.list({ kind: 'memory' }).map((m) => [m.name, m.id]))
    expect(lines).toEqual([
      `- [${byName.get('m4')}] m4`,
      `- [${byName.get('m3')}] m3`,
      `- [${byName.get('m2')}] m2`
    ])
    expect(s).toContain('(2 older memories not listed)')
    expect(s).not.toContain('alheia')
  })

  it('undo apaga a criada e restaura a anterior de uma atualização (em cadeia)', () => {
    const { memory } = unit()
    const a = memory.save({ ...who, title: 'Deploy', content: 'v1', scope: 'project' })
    memory.save({ ...who, requestId: 'r2', title: 'Deploy', content: 'v2', scope: 'project' })
    memory.save({
      ...who,
      requestId: 'r3',
      title: 'Deploy novo',
      content: 'v3',
      scope: 'project',
      id: a.instruction.id
    })
    let r = memory.undo(a.instruction.id)
    expect(r.deleted).toBe(false)
    expect(r.instruction).toMatchObject({ name: 'Deploy', body: 'v2' })
    expect(r.instruction?.origin?.requestId).toBe('r2')
    r = memory.undo(a.instruction.id)
    expect(r.instruction).toMatchObject({ name: 'Deploy', body: 'v1' })
    expect((r.instruction?.origin as StoredMemoryOrigin).previous).toBeNull()
    r = memory.undo(a.instruction.id)
    expect(r.deleted).toBe(true)
    expect(memory.get(a.instruction.id)).toBeNull()
  })

  it('deleteByOrigin apaga só as memórias com aquele terceiro', () => {
    const { memory, repo } = unit()
    memory.save({ ...who, thirdParty: ['gh1', 'gh2'], title: 'a', content: 'x', scope: 'chat' })
    memory.save({ ...who, thirdParty: ['gh2'], title: 'b', content: 'x', scope: 'chat' })
    memory.save({ ...who, title: 'c', content: 'x', scope: 'chat' })
    expect(memory.deleteByOrigin('gh1')).toBe(1)
    expect(memory.deleteByOrigin('gh2')).toBe(1)
    expect(repo.list({ kind: 'memory' }).map((m) => m.name)).toEqual(['c'])
  })
})

describe('ferramentas de memória', () => {
  it('memory_save é read (sem aprovação), emite o card e memory_read devolve o conteúdo', async () => {
    const { memory } = unit()
    const saved: unknown[] = []
    const [save, read] = createMemoryTools({
      memory,
      groupIdOf: () => null,
      requestIdOf: () => 'r9',
      thirdPartyOf: () => ['gh1'],
      onSaved: (e) => saved.push(e)
    })
    expect(save.kind).toBe('read')
    expect(read.kind).toBe('read')
    const tctx = { chatId: 'c1', projectId: 'p1', toolCallId: 'tc1' } as ToolContext
    const r = await save.run({ title: 'Pref', content: 'usar pnpm', scope: 'project' }, tctx)
    expect(r.isError).toBeFalsy()
    const m = memory.forContext({ projectId: 'p1', groupId: null, chatId: 'c1' })[0]
    expect(m.origin).toMatchObject({ chatId: 'c1', requestId: 'r9', thirdParty: ['gh1'] })
    expect(saved).toEqual([
      expect.objectContaining({ chatId: 'c1', toolCallId: 'tc1', created: true })
    ])
    // O evento não carrega o campo interno `previous`.
    expect((saved[0] as { instruction: { origin: object } }).instruction.origin).not.toHaveProperty(
      'previous'
    )
    const out = await read.run({ id: m.id }, tctx)
    expect(out.content).toContain('usar pnpm')
    expect((await read.run({ id: 'x' }, tctx)).isError).toBe(true)
    expect((await save.run({ title: 't', content: 'c', scope: 'group' }, tctx)).isError).toBe(true)
  })
})

describe('memória no engine', () => {
  it('salva pelo turno com origem (request + terceiros ativos), entra no índice e undo/deleteByOrigin', async () => {
    const dir = base()
    const root = join(dir, 'repo')
    mkdirSync(root)
    let n = 0
    const router = await startFakeRouter(() => {
      n++
      if (n === 1) {
        return {
          chunks: [
            chunk.toolCall(
              0,
              'call_1',
              'memory_save',
              JSON.stringify({
                title: 'Usar pnpm',
                content: 'O projeto usa pnpm.',
                scope: 'project'
              })
            ),
            chunk.finish('tool_calls'),
            chunk.usage(100, 5)
          ]
        }
      }
      return { chunks: [chunk.text('ok'), chunk.finish('stop'), chunk.usage(100, 5)] }
    })
    routers.push(router)
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      routerBaseUrl: router.url,
      routerApiKey: 'sk-test',
      defaultCombo: 'fake/combo',
      routerDbPath: join(dir, 'no-router.sqlite'),
      instructionFiles: [],
      skillRoots: [],
      commandRoots: [],
      agentRoots: [],
      pluginRoots: [],
      ruleRoots: []
    }
    const db = openDb(join(dir, 'db.sqlite'))
    const events: EngineEvent[] = []
    const ctx: HostContext = {
      db,
      blobs: new BlobStore(join(dir, 'blobs')),
      emit: (e) => events.push(e)
    }
    const services = createServices(ctx, {
      model: createOpenAiClient(() => cfg),
      getConfig: () => cfg,
      retryDelaysMs: [5, 5]
    })
    const project = services.projects.create(root, 'repo')
    const chat = services.chats.create({
      projectId: project.id,
      title: 't',
      color: '#fff',
      combo: 'fake/combo',
      permissionMode: 'ask'
    })
    const gh = services.instructionRepo.create({
      kind: 'rule',
      scope: 'global',
      name: 'gh-rule',
      trigger: 'always',
      body: 'Regra instalada.',
      source: {
        type: 'github',
        url: 'https://github.com/a/b',
        ref: 'main',
        path: 'r.md',
        sha: 'abc'
      }
    })
    await services.engine.send(chat.id, 'lembre que usamos pnpm', [])
    const end = Date.now() + 15_000
    while (!events.some((e) => e.type === 'turn_finished' || e.type === 'turn_error')) {
      if (Date.now() > end) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(events.find((e) => e.type === 'turn_error')).toBeUndefined()
    // Sem aprovação mesmo em modo `ask`.
    expect(events.some((e) => e.type === 'permission_requested')).toBe(false)
    const ev = events.find((e) => e.type === 'memory_saved')
    expect(ev).toMatchObject({ chatId: chat.id, toolCallId: expect.any(String), created: true })
    const mem = services.memory.forContext({
      projectId: project.id,
      groupId: null,
      chatId: chat.id
    })[0]
    expect(mem).toMatchObject({ name: 'Usar pnpm', scope: 'project', scopeId: project.id })
    const reqs = services.requests.list(chat.id)
    expect(mem.origin?.requestId).toBe(reqs[0].id)
    expect(mem.origin?.thirdParty).toEqual([gh.id])

    // O 2º request já traz o índice na seção `# Memory`.
    const sys = router.requests[1].messages[0].content as string
    expect(sys).toContain('# Memory')
    expect(sys).toContain(`- [${mem.id}] Usar pnpm`)
    expect(
      router.requests[0].tools.map((t: { function: { name: string } }) => t.function.name)
    ).toEqual(expect.arrayContaining(['memory_save', 'memory_read']))

    const handlers = Object.assign({}, ...serviceModules(services).map((m) => m(ctx)))
    expect(await handlers['memory.deleteByOrigin']({ thirdPartyId: 'outro' })).toEqual({
      deleted: 0
    })
    expect(await handlers['memory.undo']({ id: mem.id })).toBeNull()
    expect(services.memory.get(mem.id)).toBeNull()
    await expect(async () => handlers['memory.undo']({ id: mem.id })).rejects.toThrow()

    services.memory.save({
      chatId: chat.id,
      projectId: project.id,
      groupId: null,
      requestId: null,
      thirdParty: [gh.id],
      title: 'x',
      content: 'y',
      scope: 'chat'
    })
    expect(await handlers['memory.deleteByOrigin']({ thirdPartyId: gh.id })).toEqual({ deleted: 1 })
  })
})
