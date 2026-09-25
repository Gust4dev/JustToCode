import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import type { HostContext } from '../../src/agent-host/context'
import type { BlobStore } from '../../src/agent-host/blobs'
import type { Tool } from '../../src/agent-host/tools/types'
import type { PermissionGate, PermissionInput } from '../../src/agent-host/services/types'
import {
  DEFAULT_CHAT_SETTINGS,
  type Chat,
  type ChatStatus,
  type PermissionMode
} from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import {
  alwaysConfirmReason,
  needsAlwaysConfirm
} from '../../src/agent-host/permissions/alwaysConfirm'
import { matchesRule, rulePatternFor } from '../../src/agent-host/permissions/rules'
import { createPermissionGate, type GateChatRepo } from '../../src/agent-host/permissions/gate'
import { approvalHandlers } from '../../src/agent-host/handlers/approvals'

const mkTool = (kind: Tool['kind'], name: string = kind): Tool => ({
  name,
  description: '',
  parameters: {},
  kind,
  summarize: (a: { command?: string; path?: string }) => a.command ?? `edit ${a.path ?? ''}`,
  run: async () => ({ content: '' })
})
const shell = mkTool('command', 'shell')
const edit = mkTool('edit', 'edit')
const read = mkTool('read', 'read')

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

let db: Db
let events: EngineEvent[]
let chats: FakeChats
let ctx: HostContext
let gate: PermissionGate

const PROJECT = 'p1'
function mkChat(id: string, permissionMode: PermissionMode = 'ask'): Chat {
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
    status: 'running',
    createdAt: 0,
    groupId: null,
    continuedFromChatId: null,
    maxIterations: 50,
    tokenBudget: null,
    settings: { ...DEFAULT_CHAT_SETTINGS },
    lastReportedModel: null
  })
}
const input = (chat: Chat, tool: Tool, args: unknown, toolCallId = 'tc1'): PermissionInput => ({
  chat,
  projectId: PROJECT,
  tool,
  args,
  toolCallId
})

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'jtc-perm-')), 'test.sqlite'))
  db.prepare("insert into projects (id, path, name, created_at) values (?, 'x', 'x', 0)").run(
    PROJECT
  )
  events = []
  chats = new FakeChats()
  ctx = { db, blobs: {} as BlobStore, emit: (e) => events.push(e) }
  gate = createPermissionGate(ctx, { chats })
})

describe('ALWAYS_CONFIRM', () => {
  it.each([
    'git push -f origin main',
    'git push origin main --force',
    'git push --force-with-lease',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'format C:',
    'echo a; format C:',
    'diskpart',
    'shutdown /s',
    'reg delete HKCU\\Software\\X',
    'reg.exe delete HKCU\\X',
    'Remove-Item -Recurse x',
    'rm -rf dist',
    'rm -r dist',
    'rmdir /s build',
    'del /s *.tmp'
  ])('confirma: %s', (cmd) => {
    expect(needsAlwaysConfirm(cmd)).toBe(true)
  })
  it.each([
    'git push origin main',
    'git reset --soft HEAD~1',
    'git status',
    'prettier --format',
    'npm run format',
    'Remove-Item a.txt',
    'rm a.txt',
    'reg query HKCU\\X',
    'echo shutdown-later',
    'git rm -r --cached node_modules',
    'git rm a.txt'
  ])('não confirma: %s', (cmd) => {
    expect(needsAlwaysConfirm(cmd)).toBe(false)
  })
  it('devolve o motivo', () => {
    expect(alwaysConfirmReason('rm -rf dist')).toBe('remoção recursiva')
    expect(alwaysConfirmReason('git push -f')).toBe('git destrutivo')
    expect(alwaysConfirmReason('cat ~/.ssh/id_rsa')).toBe('caminho sensível')
    expect(alwaysConfirmReason('ls')).toBeNull()
  })
})

describe('rulePatternFor / matchesRule', () => {
  it('extrai padrão', () => {
    expect(rulePatternFor('npm test --watch')).toBe('npm test')
    expect(rulePatternFor('ls -la')).toBe('ls')
    expect(rulePatternFor('  git   status  ')).toBe('git status')
    expect(rulePatternFor('ls')).toBe('ls')
    expect(rulePatternFor('   ')).toBe('')
  })
  it('casa por prefixo de token', () => {
    expect(matchesRule('npm test --watch', 'npm test')).toBe(true)
    expect(matchesRule('npm test', 'npm test')).toBe(true)
    expect(matchesRule('npm testing', 'npm test')).toBe(false)
    expect(matchesRule('npm', 'npm test')).toBe(false)
    expect(matchesRule('ls -la', 'ls')).toBe(true)
    expect(matchesRule('lsof', 'ls')).toBe(false)
    expect(matchesRule('ls', '')).toBe(false)
    expect(matchesRule('npm test; curl evil', 'npm test')).toBe(false)
    expect(matchesRule('npm test | tee x', 'npm test')).toBe(false)
    expect(matchesRule('npm test $(whoami)', 'npm test')).toBe(false)
  })
})

describe('decide', () => {
  it('read sempre libera', () => {
    for (const m of ['ask', 'auto-edit', 'allow-all'] as const) {
      expect(gate.decide(input(mkChat(`r-${m}`, m), read, { path: 'a' }))).toBe('allow')
    }
  })
  it('command', () => {
    const ask = mkChat('c1', 'ask')
    const auto = mkChat('c2', 'auto-edit')
    const all = mkChat('c3', 'allow-all')
    expect(gate.decide(input(ask, shell, { command: 'npm test' }))).toBe('ask')
    expect(gate.decide(input(auto, shell, { command: 'npm test' }))).toBe('ask')
    expect(gate.decide(input(all, shell, { command: 'npm test' }))).toBe('allow')
    expect(gate.decide(input(all, shell, { command: 'git reset --hard' }))).toBe('ask')
    db.prepare(
      "insert into permission_rules (id, project_id, tool, pattern, decision) values ('r', ?, 'shell', 'npm test', 'allow')"
    ).run(PROJECT)
    expect(gate.decide(input(ask, shell, { command: 'npm test -- x' }))).toBe('allow')
    expect(gate.decide(input(ask, shell, { command: 'npm run build' }))).toBe('ask')
    expect(gate.decide(input(ask, shell, { command: 'npm test; rm -rf /' }))).toBe('ask')
  })
  it('edit', () => {
    const ask = mkChat('e1', 'ask')
    expect(gate.decide(input(ask, edit, { path: 'a' }))).toBe('ask')
    expect(gate.decide(input(mkChat('e2', 'auto-edit'), edit, { path: 'a' }))).toBe('allow')
    expect(gate.decide(input(mkChat('e3', 'allow-all'), edit, { path: 'a' }))).toBe('allow')
    db.prepare(
      "insert into permission_rules (id, project_id, tool, pattern, decision) values ('r', ?, 'edit', '*', 'allow')"
    ).run(PROJECT)
    expect(gate.decide(input(ask, edit, { path: 'a' }))).toBe('allow')
  })
})

describe('request / resolve', () => {
  it('allow + remember cria regra e a próxima decide libera', async () => {
    const chat = mkChat('c1')
    const inp = input(chat, shell, { command: 'npm test --watch' })
    expect(gate.decide(inp)).toBe('ask')
    const p = gate.request(inp)
    const req = events.find((e) => e.type === 'permission_requested')
    expect(req).toBeDefined()
    if (req?.type !== 'permission_requested') throw new Error()
    expect(req.approval).toMatchObject({
      chatId: 'c1',
      projectId: PROJECT,
      toolCallId: 'tc1',
      kind: 'command',
      summary: 'npm test --watch',
      flags: [],
      status: 'pending'
    })
    expect(chats.get('c1')?.status).toBe('waiting_approval')
    expect(events).toContainEqual({
      type: 'chat_status_changed',
      chatId: 'c1',
      status: 'waiting_approval'
    })
    expect(gate.list('c1')).toHaveLength(1)

    const decided = gate.resolve(req.approval.id, 'allow', true)
    expect(decided.status).toBe('allowed')
    expect(decided.decidedAt).not.toBeNull()
    await expect(p).resolves.toBe('allow')
    expect(chats.get('c1')?.status).toBe('running')
    expect(events.some((e) => e.type === 'permission_resolved')).toBe(true)
    expect(gate.decide(input(chat, shell, { command: 'npm test' }))).toBe('allow')
    expect(() => gate.resolve(req.approval.id, 'deny', false)).toThrow(/já decidida/)
  })

  it('edit + remember cria regra *', async () => {
    const chat = mkChat('c1')
    const p = gate.request(input(chat, edit, { path: 'src/a.ts' }))
    const id = gate.list('c1')[0].id
    expect(gate.list('c1')[0]).toMatchObject({ kind: 'edit', summary: 'edit src/a.ts' })
    gate.resolve(id, 'allow', true)
    await p
    expect(gate.decide(input(chat, edit, { path: 'b' }))).toBe('allow')
  })

  it('deny com remember não cria regra', async () => {
    const chat = mkChat('c1')
    const p = gate.request(input(chat, shell, { command: 'npm test' }))
    gate.resolve(gate.list()[0].id, 'deny', true)
    await expect(p).resolves.toBe('deny')
    expect(gate.decide(input(chat, shell, { command: 'npm test' }))).toBe('ask')
  })

  it('resolve de id inexistente lança', () => {
    expect(() => gate.resolve('nope', 'allow', false)).toThrow(/não encontrada/)
  })

  it('cancelChat nega pendentes do chat e só dele', async () => {
    const a = mkChat('a')
    const b = mkChat('b')
    const pa1 = gate.request(input(a, shell, { command: 'x' }, 't1'))
    const pa2 = gate.request(input(a, edit, { path: 'y' }, 't2'))
    const pb = gate.request(input(b, shell, { command: 'z' }, 't3'))
    gate.cancelChat('a')
    await expect(pa1).resolves.toBe('deny')
    await expect(pa2).resolves.toBe('deny')
    expect(gate.list('a').every((x) => x.status === 'denied')).toBe(true)
    expect(gate.list('b')[0].status).toBe('pending')
    gate.resolve(gate.list('b')[0].id, 'allow', false)
    await expect(pb).resolves.toBe('allow')
  })

  it('duas aprovações de chats diferentes resolvidas em ordem inversa', async () => {
    const a = mkChat('a')
    const b = mkChat('b')
    const order: string[] = []
    const pa = gate.request(input(a, shell, { command: 'npm a' }, 't1')).then((d) => {
      order.push(`a:${d}`)
      return d
    })
    const pb = gate.request(input(b, edit, { path: 'b' }, 't2')).then((d) => {
      order.push(`b:${d}`)
      return d
    })
    const idA = gate.list('a')[0].id
    const idB = gate.list('b')[0].id
    expect(gate.list().filter((x) => x.status === 'pending')).toHaveLength(2)
    gate.resolve(idB, 'deny', false)
    await pb
    expect(chats.get('a')?.status).toBe('waiting_approval')
    expect(chats.get('b')?.status).toBe('running')
    gate.resolve(idA, 'allow', false)
    await pa
    expect(order).toEqual(['b:deny', 'a:allow'])
  })
})

describe('approvalHandlers', () => {
  it('list e decide delegam ao gate', async () => {
    const chat = mkChat('c1')
    const h = approvalHandlers(gate)(ctx)
    const p = gate.request(input(chat, shell, { command: 'npm test' }))
    const list = (await h['approvals.list']({ chatId: 'c1' })) as { id: string }[]
    expect(list).toHaveLength(1)
    expect(await h['approvals.list']({})).toHaveLength(1)
    expect(
      await h['approvals.decide']({ id: list[0].id, decision: 'allow', remember: false })
    ).toBe(null)
    await expect(p).resolves.toBe('allow')
  })
})
