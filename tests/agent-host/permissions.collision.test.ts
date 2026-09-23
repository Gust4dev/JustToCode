import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import type { HostContext } from '../../src/agent-host/context'
import type { BlobStore } from '../../src/agent-host/blobs'
import type { Tool } from '../../src/agent-host/tools/types'
import type { PermissionGate, PermissionInput } from '../../src/agent-host/services/types'
import type { Chat, ChatStatus, PermissionMode } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { FileChangeRepo } from '../../src/agent-host/repo/fileChanges'
import {
  COLLISION_SUFFIX,
  createPermissionGate,
  type GateChatRepo
} from '../../src/agent-host/permissions/gate'

const mkTool = (kind: Tool['kind'], name: string): Tool => ({
  name,
  description: '',
  parameters: {},
  kind,
  summarize: (a: { command?: string; path?: string }) => a.command ?? `edit ${a.path ?? ''}`,
  run: async () => ({ content: '' })
})
const edit = mkTool('edit', 'edit_file')
const shell = mkTool('command', 'shell')

class FakeChats implements GateChatRepo {
  chats = new Map<string, Chat>()
  add(c: Chat): Chat {
    this.chats.set(c.id, c)
    return c
  }
  get(id: string): Chat | null {
    return this.chats.get(id) ?? null
  }
  setStatus(id: string, status: ChatStatus): Chat {
    const c = { ...(this.chats.get(id) as Chat), status }
    this.chats.set(id, c)
    return c
  }
}

const PROJECT = 'p1'
let db: Db
let events: EngineEvent[]
let chats: FakeChats
let changes: FileChangeRepo
let gate: PermissionGate

function mkChat(
  id: string,
  permissionMode: PermissionMode = 'ask',
  status: ChatStatus = 'running'
): Chat {
  db.prepare(
    "insert into chats (id, project_id, title, color, combo, created_at) values (?, ?, 't', '#000', 'c', 0)"
  ).run(id, PROJECT)
  return chats.add({
    id,
    projectId: PROJECT,
    parentChatId: null,
    agentName: null,
    title: 't',
    color: '#000',
    combo: 'c',
    permissionMode,
    status,
    createdAt: 0
  })
}

const touch = (chatId: string | null, path: string, candidates: string[] = []): string =>
  changes.insert({
    projectId: PROJECT,
    chatId,
    candidateChatIds: candidates,
    origin: chatId ? 'tool' : 'ambiguous',
    path,
    beforeHash: null,
    afterHash: 'h',
    toolCallId: null
  }).id

const editInput = (chat: Chat, path: string, targetPath?: string): PermissionInput => ({
  chat,
  projectId: PROJECT,
  tool: edit,
  args: { path },
  toolCallId: 'tc1',
  targetPath
})

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'jtc-coll-')), 'test.sqlite'))
  db.prepare("insert into projects (id, path, name, created_at) values (?, 'x', 'x', 0)").run(
    PROJECT
  )
  events = []
  chats = new FakeChats()
  changes = new FileChangeRepo(db)
  const ctx: HostContext = { db, blobs: {} as BlobStore, emit: (e) => events.push(e) }
  gate = createPermissionGate(ctx, { chats, fileChanges: changes })
})

describe('FileChangeRepo.chatsWithUnreviewed', () => {
  it('lista chats distintos com pendências no caminho, ignorando revisadas/revertidas e sem chat', () => {
    mkChat('a')
    mkChat('b')
    mkChat('c')
    touch('a', 'x.ts')
    touch('a', 'x.ts')
    touch('b', 'x.ts')
    const reviewed = touch('c', 'x.ts')
    changes.markReviewed([reviewed])
    touch(null, 'x.ts', ['a', 'c'])
    touch('c', 'y.ts')
    expect(changes.chatsWithUnreviewed(PROJECT, 'x.ts')).toEqual(['a', 'b'])
    expect(changes.chatsWithUnreviewed(PROJECT, 'y.ts')).toEqual(['c'])
    expect(changes.chatsWithUnreviewed(PROJECT, 'z.ts')).toEqual([])
  })
})

describe('gate — colisão entre chats', () => {
  it('pergunta mesmo em allow-all quando outro chat vivo mexeu no arquivo', () => {
    const me = mkChat('me', 'allow-all')
    mkChat('other', 'ask', 'idle')
    touch('other', 'src/a.ts')
    expect(gate.decide(editInput(me, 'src/a.ts'))).toBe('ask')
    // arquivo diferente segue liberado
    expect(gate.decide(editInput(me, 'src/b.ts'))).toBe('allow')
  })

  it('normaliza args.path quando não vem targetPath e prefere targetPath quando vem', () => {
    const me = mkChat('me', 'allow-all')
    mkChat('other', 'ask', 'running')
    touch('other', 'src/a.ts')
    expect(gate.decide(editInput(me, './src\\a.ts'))).toBe('ask')
    expect(gate.decide(editInput(me, 'C:/abs/whatever', 'src/a.ts'))).toBe('ask')
  })

  it('aprovação leva flag other_chat_touched e sufixo no summary', async () => {
    const me = mkChat('me', 'auto-edit')
    mkChat('o1', 'ask', 'waiting_approval')
    mkChat('o2', 'ask', 'idle')
    touch('o1', 'a.ts')
    touch('o2', 'a.ts')
    touch('me', 'a.ts')
    const pending = gate.request(editInput(me, 'a.ts'))
    const [approval] = gate.list('me')
    expect(approval.flags).toEqual(['other_chat_touched:o1', 'other_chat_touched:o2'])
    expect(approval.summary).toBe(`edit a.ts${COLLISION_SUFFIX}`)
    expect(approval.summary.endsWith(' — outro chat também mexeu aqui')).toBe(true)
    gate.resolve(approval.id, 'allow', false)
    await expect(pending).resolves.toBe('allow')
  })

  it('sem colisão a aprovação continua com flags vazias e summary original', async () => {
    const me = mkChat('me')
    const pending = gate.request(editInput(me, 'a.ts'))
    const [approval] = gate.list('me')
    expect(approval.flags).toEqual([])
    expect(approval.summary).toBe('edit a.ts')
    gate.resolve(approval.id, 'deny', false)
    await expect(pending).resolves.toBe('deny')
  })

  it('regra "Sempre" (edit *) não libera colisão', async () => {
    const me = mkChat('me')
    mkChat('other', 'ask', 'idle')
    // libera edições com "Sempre"
    const p = gate.request(editInput(me, 'free.ts'))
    gate.resolve(gate.list('me')[0].id, 'allow', true)
    await p
    expect(gate.decide(editInput(me, 'free.ts'))).toBe('allow')
    touch('other', 'hot.ts')
    expect(gate.decide(editInput(me, 'hot.ts'))).toBe('ask')
  })

  it('ignora o próprio chat, chats interrompidos/com erro e mudanças já revisadas', () => {
    const me = mkChat('me', 'allow-all')
    mkChat('dead', 'ask', 'interrupted')
    mkChat('err', 'ask', 'error')
    mkChat('done', 'ask', 'idle')
    touch('me', 'a.ts')
    touch('dead', 'a.ts')
    touch('err', 'a.ts')
    changes.markReviewed([touch('done', 'a.ts')])
    const reverted = touch('done', 'a.ts')
    changes.markReverted([reverted])
    expect(gate.decide(editInput(me, 'a.ts'))).toBe('allow')
  })

  it('não afeta ferramentas de comando', () => {
    const me = mkChat('me', 'allow-all')
    mkChat('other', 'ask', 'running')
    touch('other', 'a.ts')
    expect(
      gate.decide({
        chat: me,
        projectId: PROJECT,
        tool: shell,
        args: { command: 'ls a.ts' },
        toolCallId: 't'
      })
    ).toBe('allow')
  })
})
