import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { ChatRepo, type ChatCreateInput } from '../../src/agent-host/repo/chats'
import { ChatGroupRepo } from '../../src/agent-host/repo/chatGroups'
import { QueueRepo } from '../../src/agent-host/repo/queue'
import { InstructionRepo } from '../../src/agent-host/repo/instructions'
import { TouchedPathRepo } from '../../src/agent-host/repo/touchedPaths'
import { DEFAULT_CHAT_SETTINGS, type AttachmentMeta, type Chat } from '../../src/shared/domain'

let db: Db
let projects: ProjectRepo
let chats: ChatRepo
let groups: ChatGroupRepo
let queue: QueueRepo
let instructions: InstructionRepo
let touched: TouchedPathRepo
let projectId: string

const newChat = (over: Partial<ChatCreateInput> = {}): Chat =>
  chats.create({ projectId, title: 't', color: '#000', combo: 'c', ...over })

beforeEach(() => {
  db = openDb(':memory:')
  projects = new ProjectRepo(db)
  chats = new ChatRepo(db)
  groups = new ChatGroupRepo(db)
  queue = new QueueRepo(db)
  instructions = new InstructionRepo(db)
  touched = new TouchedPathRepo(db)
  projectId = projects.create(mkdtempSync(join(tmpdir(), 'jtc-c2-')), 'p').id
})

describe('ChatRepo (campos do ciclo 2)', () => {
  it('cria com os padrões', () => {
    const c = newChat()
    expect(c).toMatchObject({
      groupId: null,
      continuedFromChatId: null,
      maxIterations: 50,
      tokenBudget: null,
      settings: DEFAULT_CHAT_SETTINGS,
      lastReportedModel: null
    })
    expect(chats.get(c.id)).toEqual(c)
  })

  it('aceita campos novos na criação (maxIterations null = sem limite)', () => {
    const g = groups.create(projectId, 'G')
    const base = newChat()
    const c = newChat({
      groupId: g.id,
      continuedFromChatId: base.id,
      maxIterations: null,
      tokenBudget: 1000,
      settings: { reasoning: 'high' }
    })
    expect(chats.get(c.id)).toMatchObject({
      groupId: g.id,
      continuedFromChatId: base.id,
      maxIterations: null,
      tokenBudget: 1000,
      settings: { ...DEFAULT_CHAT_SETTINGS, reasoning: 'high' }
    })
  })

  it('update mescla settings e distingue undefined de null', () => {
    const g = groups.create(projectId, 'G')
    const c = newChat({ tokenBudget: 500 })
    let u = chats.update(c.id, {
      groupId: g.id,
      maxIterations: 10,
      settings: { reasoning: 'low', subagentCombo: 'x' }
    })
    expect(u).toMatchObject({
      groupId: g.id,
      maxIterations: 10,
      tokenBudget: 500,
      settings: { reasoning: 'low', subagentCombo: 'x', subagentReasoning: null }
    })
    u = chats.update(c.id, { settings: { reasoning: null }, tokenBudget: null, groupId: null })
    expect(u).toMatchObject({
      groupId: null,
      maxIterations: 10,
      tokenBudget: null,
      settings: { reasoning: null, subagentCombo: 'x' }
    })
    u = chats.update(c.id, { maxIterations: null })
    expect(u.maxIterations).toBeNull()
  })

  it('setLastReportedModel e listByGroup', () => {
    const g = groups.create(projectId, 'G')
    const a = newChat({ groupId: g.id })
    newChat()
    chats.setLastReportedModel(a.id, 'gpt-x')
    expect(chats.get(a.id)?.lastReportedModel).toBe('gpt-x')
    expect(chats.listByGroup(g.id).map((c) => c.id)).toEqual([a.id])
  })

  it('settings_json inválido ou nulo cai nos padrões', () => {
    const c = newChat()
    db.prepare('update chats set settings_json = ? where id = ?').run('{quebrado', c.id)
    expect(chats.get(c.id)?.settings).toEqual(DEFAULT_CHAT_SETTINGS)
    db.prepare('update chats set settings_json = null where id = ?').run(c.id)
    expect(chats.get(c.id)?.settings).toEqual(DEFAULT_CHAT_SETTINGS)
  })
})

describe('ChatGroupRepo', () => {
  it('CRUD com sort_order incremental', () => {
    const a = groups.create(projectId, 'A')
    const b = groups.create(projectId, 'B')
    expect([a.sortOrder, b.sortOrder]).toEqual([0, 1])
    expect(a).toMatchObject({ projectId, name: 'A', collapsed: false })
    expect(groups.list(projectId).map((g) => g.name)).toEqual(['A', 'B'])
    const u = groups.update(a.id, { name: 'A2', collapsed: true, sortOrder: 5 })
    expect(u).toMatchObject({ name: 'A2', collapsed: true, sortOrder: 5 })
    expect(groups.list(projectId).map((g) => g.name)).toEqual(['B', 'A2'])
    expect(groups.update(a.id, {}).collapsed).toBe(true)
    expect(() => groups.update('nope', {})).toThrow()
  })

  it('apagar o grupo deixa os chats sem grupo', () => {
    const g = groups.create(projectId, 'G')
    const c = newChat({ groupId: g.id })
    groups.remove(g.id)
    expect(groups.get(g.id)).toBeNull()
    expect(chats.get(c.id)?.groupId).toBeNull()
  })

  it('apagar o projeto apaga os grupos', () => {
    groups.create(projectId, 'G')
    projects.remove(projectId)
    expect(groups.list(projectId)).toEqual([])
  })
})

describe('QueueRepo', () => {
  const att: AttachmentMeta = {
    id: 'a1',
    kind: 'image',
    name: 'x.png',
    blobHash: 'h',
    mime: 'image/png',
    bytes: 3,
    width: 1,
    height: 1
  }

  it('FIFO por posição, edição, remoção e shift', () => {
    const c = newChat()
    const m1 = queue.enqueue(c.id, 'um', [att])
    const m2 = queue.enqueue(c.id, 'dois')
    expect([m1.position, m2.position]).toEqual([0, 1])
    expect(queue.list(c.id).map((m) => m.text)).toEqual(['um', 'dois'])
    expect(queue.get(m1.id)?.attachments).toEqual([att])
    expect(queue.editText(m2.id, 'dois!').text).toBe('dois!')
    expect(() => queue.editText('nope', 'x')).toThrow()
    expect(queue.peek(c.id)?.id).toBe(m1.id)
    expect(queue.shift(c.id)?.id).toBe(m1.id)
    expect(queue.list(c.id).map((m) => m.id)).toEqual([m2.id])
    queue.remove(m2.id)
    expect(queue.shift(c.id)).toBeNull()
  })

  it('estado de pausa', () => {
    const c = newChat()
    queue.enqueue(c.id, 'a')
    expect(queue.state(c.id)).toMatchObject({ chatId: c.id, paused: false, pauseReason: null })
    queue.setPaused(c.id, true, 'erro')
    expect(queue.state(c.id)).toMatchObject({ paused: true, pauseReason: 'erro' })
    expect(queue.state(c.id).items).toHaveLength(1)
    queue.setPaused(c.id, false, 'ignorado')
    expect(queue.state(c.id)).toMatchObject({ paused: false, pauseReason: null })
  })

  it('apagar o chat apaga fila e estado', () => {
    const c = newChat()
    queue.enqueue(c.id, 'a')
    queue.setPaused(c.id, true, 'x')
    chats.remove(c.id)
    expect(queue.list(c.id)).toEqual([])
    expect(db.prepare('select count(*) as n from chat_queue_state').get()).toEqual({ n: 0 })
  })

  it('clear', () => {
    const c = newChat()
    queue.enqueue(c.id, 'a')
    queue.enqueue(c.id, 'b')
    queue.clear(c.id)
    expect(queue.list(c.id)).toEqual([])
  })
})

describe('InstructionRepo', () => {
  it('cria com padrões, lê, atualiza e remove', () => {
    const i = instructions.create({
      kind: 'rule',
      scope: 'global',
      scopeId: 'ignorado',
      name: 'r',
      trigger: 'always',
      body: 'seja breve'
    })
    expect(i).toMatchObject({
      scopeId: null,
      description: '',
      globs: [],
      format: 'md',
      source: { type: 'app' },
      enabled: true,
      readonly: false,
      origin: null
    })
    expect(instructions.get(i.id)).toEqual(i)
    const u = instructions.update(i.id, { body: 'novo', globs: ['src/**'], trigger: 'glob' })
    expect(u).toMatchObject({ body: 'novo', globs: ['src/**'], trigger: 'glob' })
    expect(u.updatedAt).toBeGreaterThan(i.updatedAt)
    expect(instructions.setEnabled(i.id, false).enabled).toBe(false)
    instructions.remove(i.id)
    expect(instructions.get(i.id)).toBeNull()
    expect(() => instructions.update(i.id, {})).toThrow()
  })

  it('readonly para fontes arquivo/plugin; origin de memória', () => {
    const f = instructions.create({
      kind: 'skill',
      scope: 'project',
      scopeId: projectId,
      name: 's',
      trigger: 'model',
      body: 'b',
      source: { type: 'file', path: '/x/SKILL.md' }
    })
    expect(f.readonly).toBe(true)
    const g = instructions.create({
      kind: 'command',
      scope: 'global',
      name: 'c',
      trigger: 'manual',
      body: 'b',
      format: 'toml',
      source: { type: 'github', url: 'u', ref: 'main', path: 'p', sha: 's' }
    })
    expect(g).toMatchObject({ readonly: true, format: 'toml' })
    const m = instructions.create({
      kind: 'memory',
      scope: 'chat',
      scopeId: 'c1',
      name: 'm',
      trigger: 'always',
      body: 'b',
      origin: { chatId: 'c1', requestId: null, thirdParty: ['fulano'] }
    })
    expect(instructions.get(m.id)?.origin).toEqual({
      chatId: 'c1',
      requestId: null,
      thirdParty: ['fulano']
    })
  })

  it('list por escopo/kind e listForContext', () => {
    const mk = (
      scope: 'global' | 'project' | 'group' | 'chat',
      scopeId: string | null,
      name: string,
      kind: 'rule' | 'memory' = 'rule'
    ): string =>
      instructions.create({ kind, scope, scopeId, name, trigger: 'always', body: name }).id
    mk('chat', 'c1', 'chat')
    mk('group', 'g1', 'group')
    mk('project', 'p1', 'proj')
    mk('project', 'p2', 'outro')
    mk('global', null, 'glob')
    mk('global', null, 'mem', 'memory')

    expect(instructions.list().map((i) => i.name)).toEqual([
      'glob',
      'mem',
      'outro',
      'proj',
      'group',
      'chat'
    ])
    expect(instructions.list({ scope: 'project', scopeId: 'p1' }).map((i) => i.name)).toEqual([
      'proj'
    ])
    expect(instructions.list({ scope: 'global', scopeId: null }).map((i) => i.name)).toEqual([
      'glob',
      'mem'
    ])
    expect(instructions.list({ kind: 'memory' }).map((i) => i.name)).toEqual(['mem'])
    expect(
      instructions
        .listForContext({ projectId: 'p1', groupId: 'g1', chatId: 'c1' })
        .map((i) => i.name)
    ).toEqual(['glob', 'mem', 'proj', 'group', 'chat'])
    expect(
      instructions.listForContext({ projectId: 'p1', kind: 'rule' }).map((i) => i.name)
    ).toEqual(['glob', 'proj'])
  })

  it('toggles de descobertos', () => {
    expect(instructions.getToggle('file:x')).toBeNull()
    instructions.setToggle('file:x', false)
    expect(instructions.getToggle('file:x')).toBe(false)
    instructions.setToggle('file:x', true)
    instructions.setToggle('file:y', false)
    expect(instructions.toggles()).toEqual(
      new Map([
        ['file:x', true],
        ['file:y', false]
      ])
    )
    instructions.clearToggle('file:x')
    expect(instructions.getToggle('file:x')).toBeNull()
  })
})

describe('limpeza de instruções ao excluir escopos (migração 6)', () => {
  const mk = (scope: 'global' | 'project' | 'group' | 'chat', scopeId: string | null): string =>
    instructions.create({
      kind: scope === 'chat' ? 'memory' : 'rule',
      scope,
      scopeId,
      name: `${scope}:${scopeId}`,
      trigger: 'always',
      body: 'b'
    }).id
  const names = (): string[] => instructions.list().map((i) => i.name)

  it('excluir chat apaga as instruções do chat, dos subagentes e os caminhos tocados', () => {
    const c = newChat()
    const sub = newChat({ parentChatId: c.id })
    const other = newChat()
    mk('chat', c.id)
    mk('chat', sub.id)
    mk('chat', other.id)
    mk('project', projectId)
    touched.add(c.id, 'a.ts')
    chats.remove(c.id)
    expect(names().sort()).toEqual([`chat:${other.id}`, `project:${projectId}`].sort())
    expect(touched.list(c.id)).toEqual([])
  })

  it('excluir grupo apaga só as instruções do grupo; chats ficam', () => {
    const g = groups.create(projectId, 'G')
    const g2 = groups.create(projectId, 'H')
    const c = newChat({ groupId: g.id })
    mk('group', g.id)
    mk('group', g2.id)
    mk('chat', c.id)
    groups.remove(g.id)
    expect(names().sort()).toEqual([`chat:${c.id}`, `group:${g2.id}`].sort())
  })

  it('excluir projeto apaga instruções de projeto, grupos e chats dele; outros ficam', () => {
    const g = groups.create(projectId, 'G')
    const c = newChat({ groupId: g.id })
    const sub = newChat({ parentChatId: c.id })
    mk('project', projectId)
    mk('group', g.id)
    mk('chat', c.id)
    mk('chat', sub.id)
    mk('global', null)
    const p2 = projects.create(mkdtempSync(join(tmpdir(), 'jtc-c2-')), 'p2').id
    const c2 = chats.create({ projectId: p2, title: 't', color: '#000', combo: 'c' })
    const g2 = groups.create(p2, 'G2')
    mk('project', p2)
    mk('group', g2.id)
    mk('chat', c2.id)
    projects.remove(projectId)
    expect(names().sort()).toEqual(
      ['global:null', `project:${p2}`, `group:${g2.id}`, `chat:${c2.id}`].sort()
    )
  })
})

describe('TouchedPathRepo', () => {
  it('add idempotente, list, clear e cascade', () => {
    const c = newChat()
    touched.add(c.id, 'src/a.ts')
    touched.add(c.id, 'src/b.ts')
    touched.add(c.id, 'src/a.ts')
    expect(touched.list(c.id)).toEqual(['src/a.ts', 'src/b.ts'])
    touched.clear(c.id)
    expect(touched.list(c.id)).toEqual([])
    touched.add(c.id, 'x')
    chats.remove(c.id)
    expect(touched.list(c.id)).toEqual([])
  })
})
