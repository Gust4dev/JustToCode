import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { setConfig } from '../../src/agent-host/config'
import type { Handler, HostContext } from '../../src/agent-host/context'
import { projectHandlers } from '../../src/agent-host/handlers/projects'
import { chatHandlers } from '../../src/agent-host/handlers/chats'
import { MessageRepo } from '../../src/agent-host/repo/messages'
import { ToolCallRepo } from '../../src/agent-host/repo/toolCalls'
import { RequestRepo } from '../../src/agent-host/repo/requests'
import type { Chat, Project } from '../../src/shared/domain'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'jtc-hp-'))
const gitRepo = (): string => {
  const d = tmp()
  execFileSync('git', ['init', '-q', d])
  return d
}

let ctx: HostContext
let h: Record<string, Handler>
const call = async <T>(m: string, p: unknown): Promise<T> => (await h[m](p)) as T

beforeEach(() => {
  ctx = { db: openDb(':memory:'), blobs: new BlobStore(tmp()), emit: () => {} }
  h = { ...projectHandlers(ctx), ...chatHandlers(ctx) }
})

describe('projects handlers', () => {
  it('rejeita pasta sem .git', async () => {
    await expect(call('projects.open', { path: tmp() })).rejects.toMatchObject({
      code: 'NOT_GIT_REPO',
      message: 'A pasta não é um repositório git'
    })
  })

  it('rejeita pasta inexistente', async () => {
    await expect(call('projects.open', { path: join(tmp(), 'nada') })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('aceita repo com git init e .git como arquivo', async () => {
    const repo = gitRepo()
    const p = await call<Project>('projects.open', { path: repo })
    expect(p.path).toBe(repo)
    const wt = tmp()
    writeFileSync(join(wt, '.git'), 'gitdir: ../x')
    await expect(call<Project>('projects.open', { path: wt })).resolves.toMatchObject({ path: wt })
    expect(await call<Project[]>('projects.list', null)).toHaveLength(2)
  })

  it('abrir o mesmo caminho duas vezes devolve o mesmo projeto', async () => {
    const repo = gitRepo()
    const a = await call<Project>('projects.open', { path: repo })
    const variant =
      process.platform === 'win32' ? repo.replace(/\\/g, '/').toUpperCase() + '/' : repo + '/'
    const b = await call<Project>('projects.open', { path: variant })
    expect(b.id).toBe(a.id)
    expect(await call<Project[]>('projects.list', null)).toHaveLength(1)
    await call('projects.remove', { id: a.id })
    expect(await call<Project[]>('projects.list', null)).toEqual([])
  })
})

describe('chats handlers', () => {
  it('create usa padrões (título, combo da config, cor) e update/delete', async () => {
    setConfig({ defaultCombo: 'combo-padrao' })
    const repoDir = gitRepo()
    mkdirSync(join(repoDir, 'src'))
    const p = await call<Project>('projects.open', { path: repoDir })
    const c = await call<Chat>('chats.create', { projectId: p.id })
    expect(c).toMatchObject({ title: 'Novo chat', combo: 'combo-padrao', color: '#7F77DD' })
    const c2 = await call<Chat>('chats.create', { projectId: p.id, title: 'X', combo: 'outro' })
    expect(c2).toMatchObject({ title: 'X', combo: 'outro', color: '#1D9E75' })
    const u = await call<Chat>('chats.update', { id: c.id, permissionMode: 'allow-all' })
    expect(u.permissionMode).toBe('allow-all')
    expect((await call<Chat[]>('chats.list', { projectId: p.id })).map((x) => x.id)).toEqual([
      c2.id,
      c.id
    ])
    await call('chats.delete', { id: c2.id })
    expect(await call<Chat[]>('chats.list', { projectId: p.id })).toHaveLength(1)
    await expect(call('chats.create', { projectId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('messages, toolCalls e requests', async () => {
    const p = await call<Project>('projects.open', { path: gitRepo() })
    const c = await call<Chat>('chats.create', { projectId: p.id })
    const msg = new MessageRepo(ctx.db).append(c.id, { role: 'user', content: 'oi' })
    expect(await call('messages.list', { chatId: c.id })).toEqual([msg])
    // Inclui as compactadas (a UI mostra o histórico inteiro).
    const repo = new MessageRepo(ctx.db)
    const msg2 = repo.append(c.id, { role: 'assistant', content: 'olá' })
    repo.markCompacted(c.id, [msg.seq])
    expect(await call('messages.list', { chatId: c.id })).toEqual([
      { ...msg, compacted: true },
      msg2
    ])
    expect(repo.list(c.id)).toEqual([msg2])

    const tcs = new ToolCallRepo(ctx.db)
    const t1 = tcs.create({
      messageId: msg.id,
      chatId: c.id,
      modelCallId: 'a',
      name: 'x',
      args: {}
    })
    tcs.update(t1.id, { outputPreview: 'prévia' })
    expect(await call('toolCalls.output', { id: t1.id })).toEqual({ text: 'prévia' })
    tcs.update(t1.id, { outputBlobHash: ctx.blobs.put('saída completa') })
    expect(await call('toolCalls.output', { id: t1.id })).toEqual({ text: 'saída completa' })
    expect(await call<unknown[]>('toolCalls.list', { chatId: c.id })).toHaveLength(1)

    const r = new RequestRepo(ctx.db).start({
      chatId: c.id,
      payloadBlobHash: ctx.blobs.put('{"model":"m"}'),
      modelRequested: 'm',
      estTokens: 1,
      effectiveWindow: null
    })
    expect(await call<unknown[]>('requests.list', { chatId: c.id })).toHaveLength(1)
    expect(await call('requests.payload', { id: r.id })).toEqual({ json: '{"model":"m"}' })
  })
})
