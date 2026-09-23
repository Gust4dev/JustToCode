import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { ChatRepo } from '../../src/agent-host/repo/chats'
import { MessageRepo } from '../../src/agent-host/repo/messages'
import { RequestRepo } from '../../src/agent-host/repo/requests'
import { ToolCallRepo } from '../../src/agent-host/repo/toolCalls'
import { CHAT_COLORS } from '../../src/shared/domain'

const dir = (): string => mkdtempSync(join(tmpdir(), 'jtc-repo-'))

let db: Db
let projects: ProjectRepo
let chats: ChatRepo
let messages: MessageRepo
let requests: RequestRepo
let toolCalls: ToolCallRepo

beforeEach(() => {
  db = openDb(':memory:')
  projects = new ProjectRepo(db)
  chats = new ChatRepo(db)
  messages = new MessageRepo(db)
  requests = new RequestRepo(db)
  toolCalls = new ToolCallRepo(db)
})

describe('ProjectRepo', () => {
  it('CRUD', () => {
    const d = dir()
    const p = projects.create(d, 'proj')
    expect(p).toMatchObject({ name: 'proj', path: d })
    expect(projects.get(p.id)).toEqual(p)
    expect(projects.getByPath(d)?.id).toBe(p.id)
    expect(projects.get('nope')).toBeNull()
    projects.remove(p.id)
    expect(projects.get(p.id)).toBeNull()
    expect(projects.list()).toEqual([])
  })

  it('getByPath ignora barra final, separador e caixa (Windows)', () => {
    const d = dir()
    const p = projects.create(d, 'x')
    expect(projects.getByPath(d + '/')?.id).toBe(p.id)
    if (process.platform === 'win32') {
      expect(projects.getByPath(d.toUpperCase().replace(/\\/g, '/'))?.id).toBe(p.id)
    }
  })

  it('list ordena por last_opened_at desc e touch atualiza', () => {
    const a = projects.create(dir(), 'a')
    const b = projects.create(dir(), 'b')
    db.prepare('update projects set last_opened_at = ? where id = ?').run(1000, a.id)
    db.prepare('update projects set last_opened_at = ? where id = ?').run(2000, b.id)
    expect(projects.list().map((p) => p.name)).toEqual(['b', 'a'])
    projects.touch(a.id)
    expect(projects.list().map((p) => p.name)).toEqual(['a', 'b'])
  })
})

describe('ChatRepo', () => {
  it('CRUD, status, listByProject só top-level e remoção em cascata', () => {
    const p = projects.create(dir(), 'p')
    const c1 = chats.create({ projectId: p.id, title: 'um', color: '#fff', combo: 'dev' })
    expect(c1).toMatchObject({
      title: 'um',
      combo: 'dev',
      permissionMode: 'ask',
      status: 'idle',
      parentChatId: null,
      agentName: null
    })
    const c2 = chats.create({ projectId: p.id, title: 'dois', color: '#000', combo: 'dev' })
    chats.create({
      projectId: p.id,
      title: 'sub',
      color: '#000',
      combo: 'dev',
      parentChatId: c1.id,
      agentName: 'explorer'
    })
    expect(chats.listByProject(p.id).map((c) => c.id)).toEqual([c2.id, c1.id])

    const u = chats.update(c1.id, { title: 'novo', permissionMode: 'auto-edit' })
    expect(u).toMatchObject({ title: 'novo', combo: 'dev', permissionMode: 'auto-edit' })
    expect(chats.setStatus(c1.id, 'running').status).toBe('running')
    expect(chats.get(c1.id)?.status).toBe('running')
    expect(() => chats.update('nope', { title: 'x' })).toThrow()

    chats.remove(c2.id)
    expect(chats.get(c2.id)).toBeNull()
    projects.remove(p.id)
    expect(chats.get(c1.id)).toBeNull()
  })

  it('children lista só os subagentes do pai, do mais antigo ao mais novo', () => {
    const p = projects.create(dir(), 'p')
    const pai = chats.create({ projectId: p.id, title: 'pai', color: '#fff', combo: 'dev' })
    const outro = chats.create({ projectId: p.id, title: 'outro', color: '#fff', combo: 'dev' })
    const s1 = chats.create({
      projectId: p.id,
      title: 's1',
      color: '#fff',
      combo: 'dev',
      parentChatId: pai.id,
      agentName: 'explorer'
    })
    const s2 = chats.create({
      projectId: p.id,
      title: 's2',
      color: '#fff',
      combo: 'dev',
      parentChatId: pai.id,
      agentName: 'reviewer'
    })
    chats.create({
      projectId: p.id,
      title: 'x',
      color: '#fff',
      combo: 'dev',
      parentChatId: outro.id,
      agentName: 'explorer'
    })
    const kids = chats.children(pai.id)
    expect(kids.map((c) => c.id)).toEqual([s1.id, s2.id])
    expect(kids[0]).toMatchObject({ parentChatId: pai.id, agentName: 'explorer' })
    expect(chats.children(s1.id)).toEqual([])
    expect(chats.listByProject(p.id).map((c) => c.id)).toEqual([outro.id, pai.id])
    chats.remove(pai.id)
    expect(chats.get(s1.id)).toBeNull()
    expect(chats.children(pai.id)).toEqual([])
  })

  it('nextColor gira pela paleta', () => {
    const p = projects.create(dir(), 'p')
    expect(chats.nextColor(p.id)).toBe(CHAT_COLORS[0])
    chats.create({ projectId: p.id, title: 't', color: CHAT_COLORS[0], combo: '' })
    expect(chats.nextColor(p.id)).toBe(CHAT_COLORS[1])
  })
})

describe('MessageRepo', () => {
  const setup = (): string => {
    const p = projects.create(dir(), 'p')
    return chats.create({ projectId: p.id, title: 't', color: '#fff', combo: 'c' }).id
  }

  it('append/get com extras', () => {
    const chatId = setup()
    const m = messages.append(
      chatId,
      { role: 'user', content: 'oi' },
      { tokenEst: 3, modelUsed: 'm', requestId: 'r' }
    )
    expect(m).toMatchObject({
      seq: 1,
      tokenEst: 3,
      modelUsed: 'm',
      requestId: 'r',
      compacted: false,
      kind: 'message',
      attachments: []
    })
    expect(messages.get(m.id)).toEqual(m)
    expect(messages.get('nope')).toBeNull()
  })

  it("append aceita kind 'summary' e o preserva em get/list", () => {
    const chatId = setup()
    const s = messages.append(chatId, { role: 'user', content: 'resumo' }, { kind: 'summary' })
    expect(s.kind).toBe('summary')
    expect(messages.get(s.id)?.kind).toBe('summary')
    expect(messages.list(chatId)[0].kind).toBe('summary')
  })

  it('markCompacted marca só os seqs do chat, sem apagar', () => {
    const chatId = setup()
    const other = setup()
    for (let i = 0; i < 4; i++) messages.append(chatId, { role: 'user', content: String(i) })
    messages.append(other, { role: 'user', content: 'o' })
    messages.markCompacted(chatId, [1, 2])
    messages.markCompacted(chatId, [])
    expect(messages.list(chatId).map((m) => m.seq)).toEqual([3, 4])
    const all = messages.list(chatId, { includeCompacted: true })
    expect(all.map((m) => [m.seq, m.compacted])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false]
    ])
    expect(messages.list(other)[0].compacted).toBe(false)
  })

  it('seq contínuo em 50 appends', () => {
    const chatId = setup()
    const other = setup()
    for (let i = 0; i < 50; i++) {
      messages.append(chatId, { role: 'user', content: String(i) })
      if (i % 10 === 0) messages.append(other, { role: 'user', content: 'x' })
    }
    const list = messages.list(chatId)
    expect(list.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(list[49].message).toEqual({ role: 'user', content: '49' })
    expect(messages.list(other).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('list com e sem includeCompacted', () => {
    const chatId = setup()
    const a = messages.append(chatId, { role: 'user', content: 'a' })
    messages.append(chatId, { role: 'assistant', content: 'b' })
    db.prepare('update messages set compacted = 1 where id = ?').run(a.id)
    expect(messages.list(chatId).map((m) => m.seq)).toEqual([2])
    const all = messages.list(chatId, { includeCompacted: true })
    expect(all.map((m) => m.seq)).toEqual([1, 2])
    expect(all[0].compacted).toBe(true)
  })

  it('attachments voltam junto com a mensagem', () => {
    const chatId = setup()
    const m = messages.append(chatId, { role: 'user', content: 'veja' })
    const n = messages.append(chatId, { role: 'user', content: 'sem anexo' })
    const att = messages.addAttachment(m.id, {
      kind: 'image',
      name: 'a.png',
      blobHash: 'h1',
      mime: 'image/png',
      bytes: 10,
      width: 2,
      height: 3
    })
    messages.addAttachment(m.id, {
      kind: 'file',
      name: 'b.txt',
      blobHash: 'h2',
      mime: 'text/plain',
      bytes: 5,
      width: null,
      height: null
    })
    const list = messages.list(chatId)
    expect(list[0].attachments.map((a) => a.name)).toEqual(['a.png', 'b.txt'])
    expect(list[0].attachments[0]).toEqual(att)
    expect(list[1].attachments).toEqual([])
    expect(messages.get(m.id)?.attachments).toHaveLength(2)
    expect(messages.get(n.id)?.attachments).toEqual([])
  })
})

describe('RequestRepo', () => {
  it('start/finish/list/get', () => {
    const p = projects.create(dir(), 'p')
    const chatId = chats.create({ projectId: p.id, title: 't', color: '#fff', combo: 'c' }).id
    const r = requests.start({
      chatId,
      payloadBlobHash: 'ph',
      modelRequested: 'combo',
      estTokens: 100,
      effectiveWindow: 8000
    })
    expect(r).toMatchObject({ modelRequested: 'combo', estTokens: 100, finishedAt: null })
    expect(requests.get(r.id)?.payloadBlobHash).toBe('ph')
    const f = requests.finish(r.id, { modelReported: 'gpt', promptTokens: 90, completionTokens: 5 })
    expect(f).toMatchObject({
      modelReported: 'gpt',
      promptTokens: 90,
      completionTokens: 5,
      error: null
    })
    expect(f.finishedAt).not.toBeNull()
    expect(f).not.toHaveProperty('payloadBlobHash')
    const r2 = requests.start({
      chatId,
      payloadBlobHash: 'ph2',
      modelRequested: 'combo',
      estTokens: 1,
      effectiveWindow: null
    })
    requests.finish(r2.id, { error: 'boom' })
    expect(requests.list(chatId).map((x) => x.id)).toEqual([r.id, r2.id])
    expect(requests.get(r2.id)?.error).toBe('boom')
    expect(requests.get('nope')).toBeNull()
    expect(() => requests.finish('nope', {})).toThrow()
  })
})

describe('ToolCallRepo', () => {
  it('create/update/get/listByChat', () => {
    const p = projects.create(dir(), 'p')
    const chatId = chats.create({ projectId: p.id, title: 't', color: '#fff', combo: 'c' }).id
    const msg = messages.append(chatId, { role: 'assistant', content: null })
    const tc = toolCalls.create({
      messageId: msg.id,
      chatId,
      modelCallId: 'call_1',
      name: 'read_file',
      args: { path: 'a.ts' }
    })
    expect(tc).toMatchObject({
      modelCallId: 'call_1',
      name: 'read_file',
      args: { path: 'a.ts' },
      status: 'pending',
      outputPreview: null,
      outputTruncated: false
    })
    const u = toolCalls.update(tc.id, {
      status: 'done',
      outputBlobHash: 'oh',
      outputPreview: 'prev',
      outputTruncated: true,
      startedAt: 1,
      finishedAt: 2
    })
    expect(u).toMatchObject({
      status: 'done',
      outputPreview: 'prev',
      outputTruncated: true,
      startedAt: 1,
      finishedAt: 2
    })
    expect(u).not.toHaveProperty('outputBlobHash')
    expect(toolCalls.get(tc.id)?.outputBlobHash).toBe('oh')
    toolCalls.create({ messageId: msg.id, chatId, modelCallId: 'call_2', name: 'grep', args: {} })
    expect(toolCalls.listByChat(chatId).map((t) => t.modelCallId)).toEqual(['call_1', 'call_2'])
    expect(toolCalls.get('nope')).toBeNull()
    expect(() => toolCalls.update('nope', { status: 'error' })).toThrow()
  })
})
