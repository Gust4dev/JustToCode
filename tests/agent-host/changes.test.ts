import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { FileChangeRepo } from '../../src/agent-host/repo/fileChanges'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { createChangeCapture } from '../../src/agent-host/attribution/capture'
import {
  createChangesService,
  REVERT_CONFLICT_MESSAGE,
  type ChangesService
} from '../../src/agent-host/attribution/changesService'
import type { CaptureMeta, ChangeCapture } from '../../src/agent-host/services/types'

interface Env {
  root: string
  projectId: string
  repo: FileChangeRepo
  capture: ChangeCapture
  svc: ChangesService
  events: EngineEvent[]
  meta: (chatId: string) => CaptureMeta
  /** Simula uma escrita de ferramenta: grava no disco e registra. */
  write: (chatId: string, rel: string, content: string | null) => void
}

function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jtc-chg-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'a.txt'), 'um\ndois\ntrês\n')
  const db = openDb(join(base, 'db.sqlite'))
  const projects = new ProjectRepo(db)
  const projectId = projects.create(root, 'repo').id
  const blobs = new BlobStore(join(base, 'blobs'))
  const repo = new FileChangeRepo(db)
  const events: EngineEvent[] = []
  const ctx = { db, blobs, emit: (e: EngineEvent): void => void events.push(e) }
  const capture = createChangeCapture(ctx, repo)
  const svc = createChangesService(ctx, repo, projects)
  const meta = (chatId: string): CaptureMeta => ({
    projectId,
    projectRoot: root,
    chatId,
    toolCallId: 't-' + chatId
  })
  const write = (chatId: string, rel: string, content: string | null): void => {
    const abs = join(root, rel)
    const before = existsSync(abs) ? readFileSync(abs) : null
    const after = content === null ? null : Buffer.from(content)
    if (after) writeFileSync(abs, after)
    capture.recordToolWrite(meta(chatId), rel, before, after)
  }
  return { root, projectId, repo, capture, svc, events, meta, write }
}

describe('changes service', () => {
  let env: Env
  beforeEach(() => {
    env = setup()
  })

  it('list agrupa por caminho e conta linhas', async () => {
    env.write('c1', 'a.txt', 'um\nDOIS\ntrês\n')
    env.write('c2', 'a.txt', 'um\nDOIS\ntrês\nquatro\n')
    env.write('c1', 'novo.txt', 'x\ny\n')
    const list = await env.svc.list({ projectId: env.projectId })
    expect(list.map((f) => f.path)).toEqual(['a.txt', 'novo.txt'])
    const a = list[0]
    expect(a.chatIds).toEqual(['c1', 'c2'])
    expect(a.origins).toEqual(['tool'])
    expect(a.additions).toBe(2)
    expect(a.deletions).toBe(1)
    expect(a.binary).toBe(false)
    expect(a.currentHash).not.toBe(a.baseHash)
    const n = list[1]
    expect(n.baseHash).toBeNull()
    expect(n.additions).toBe(2)
    expect(n.deletions).toBe(0)
  })

  it('detecta binário', async () => {
    env.write('c1', 'bin.dat', 'a\0b')
    const [f] = await env.svc.list({ projectId: env.projectId })
    expect(f.binary).toBe(true)
    const d = await env.svc.fileDiff({ projectId: env.projectId, path: 'bin.dat' })
    expect(d).toEqual({ before: null, after: null, binary: true })
  })

  it('filtra por chat', async () => {
    env.write('c1', 'a.txt', 'mudou\n')
    env.write('c2', 'b.txt', 'b\n')
    const list = await env.svc.list({ projectId: env.projectId, chatId: 'c2' })
    expect(list.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('fileDiff devolve base e disco', async () => {
    env.write('c1', 'a.txt', 'novo\n')
    const d = await env.svc.fileDiff({ projectId: env.projectId, path: 'a.txt' })
    expect(d).toEqual({ before: 'um\ndois\ntrês\n', after: 'novo\n', binary: false })
  })

  it('arquivo criado e revertido é apagado', async () => {
    env.write('c1', 'novo.txt', 'x\n')
    env.events.length = 0
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'novo.txt' })
    expect(r).toEqual({ status: 'reverted' })
    expect(existsSync(join(env.root, 'novo.txt'))).toBe(false)
    // Mudança líquida zero: nada pendente e o registro do revert fica revisado.
    expect(env.repo.forPath(env.projectId, 'novo.txt')).toEqual([])
    expect(await env.svc.list({ projectId: env.projectId })).toEqual([])
    expect(env.events).toEqual([
      {
        type: 'file_touched',
        projectId: env.projectId,
        chatId: null,
        path: 'novo.txt',
        origin: 'tool'
      }
    ])
  })

  it('arquivo modificado e revertido volta ao original', async () => {
    env.write('c1', 'a.txt', 'primeira\n')
    env.write('c1', 'a.txt', 'segunda\n')
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'a.txt' })
    expect(r.status).toBe('reverted')
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('um\ndois\ntrês\n')
    expect(await env.svc.list({ projectId: env.projectId })).toEqual([])
  })

  it('revert com mudança anterior de outro chat mantém o arquivo listado', async () => {
    env.write('c1', 'a.txt', 'do c1\n')
    env.write('c2', 'a.txt', 'do c2\n')
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c2', path: 'a.txt' })
    expect(r.status).toBe('reverted')
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('do c1\n')
    const list = await env.svc.list({ projectId: env.projectId })
    expect(list.map((f) => f.path)).toEqual(['a.txt'])
    expect(list[0].chatIds).toEqual(['c1'])
  })

  it('list esconde e marca revisado arquivo que voltou à base', async () => {
    env.write('c1', 'a.txt', 'mudou\n')
    writeFileSync(join(env.root, 'a.txt'), 'um\ndois\ntrês\n')
    expect(await env.svc.list({ projectId: env.projectId })).toEqual([])
    expect(env.repo.forPath(env.projectId, 'a.txt')).toEqual([])
  })

  it('conflito quando o disco difere do depois do chat', async () => {
    env.write('c1', 'a.txt', 'do chat\n')
    writeFileSync(join(env.root, 'a.txt'), 'mexido por fora\n')
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'a.txt' })
    expect(r.status).toBe('conflict')
    expect(r.message).toBe(REVERT_CONFLICT_MESSAGE)
    expect(r.conflict?.merged).toContain('<<<<<<<')
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('mexido por fora\n')
  })

  it('accept remove da lista (arquivo, chat e projeto)', async () => {
    env.write('c1', 'a.txt', 'x\n')
    env.write('c1', 'b.txt', 'b\n')
    env.write('c2', 'c.txt', 'c\n')
    env.svc.accept({ projectId: env.projectId, path: 'a.txt' })
    expect((await env.svc.list({ projectId: env.projectId })).map((f) => f.path)).toEqual([
      'b.txt',
      'c.txt'
    ])
    env.svc.accept({ projectId: env.projectId, chatId: 'c2' })
    expect((await env.svc.list({ projectId: env.projectId })).map((f) => f.path)).toEqual(['b.txt'])
    env.svc.accept({ projectId: env.projectId })
    expect(await env.svc.list({ projectId: env.projectId })).toEqual([])
  })

  it('rejeita caminho fora do projeto', async () => {
    await expect(
      env.svc.fileDiff({ projectId: env.projectId, path: '../fora.txt' })
    ).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })
})
