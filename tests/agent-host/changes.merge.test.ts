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
  BINARY_CONFLICT_MESSAGE,
  createChangesService,
  REVERT_CONFLICT_MESSAGE,
  type ChangesService
} from '../../src/agent-host/attribution/changesService'
import { threeWayMerge } from '../../src/agent-host/attribution/merge'

const BASE = 'l1\nl2\nl3\nl4\nl5\nl6\n'

interface Env {
  root: string
  projectId: string
  repo: FileChangeRepo
  svc: ChangesService
  events: EngineEvent[]
  write: (chatId: string, rel: string, content: string | null) => void
  read: (rel: string) => string
}

function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jtc-merge-svc-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'a.txt'), BASE)
  const db = openDb(join(base, 'db.sqlite'))
  const projects = new ProjectRepo(db)
  const projectId = projects.create(root, 'repo').id
  const blobs = new BlobStore(join(base, 'blobs'))
  const repo = new FileChangeRepo(db)
  const events: EngineEvent[] = []
  const ctx = { db, blobs, emit: (e: EngineEvent): void => void events.push(e) }
  const capture = createChangeCapture(ctx, repo)
  const svc = createChangesService(ctx, repo, projects)
  const write = (chatId: string, rel: string, content: string | null): void => {
    const abs = join(root, rel)
    const before = existsSync(abs) ? readFileSync(abs) : null
    const after = content === null ? null : Buffer.from(content)
    if (after) writeFileSync(abs, after)
    capture.recordToolWrite(
      { projectId, projectRoot: root, chatId, toolCallId: 't-' + chatId },
      rel,
      before,
      after
    )
  }
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
  return { root, projectId, repo, svc, events, write, read }
}

describe('threeWayMerge', () => {
  it('limpo quando as regiões são diferentes', async () => {
    const r = await threeWayMerge('l1\nl2\nX\n', 'l1\nl2\nl3\n', 'Y\nl2\nl3\n')
    expect(r).toEqual({ clean: true, text: 'Y\nl2\nX\n' })
  })

  it('conflito na mesma linha traz marcadores diff3', async () => {
    const r = await threeWayMerge('a\nX\nc\n', 'a\nB\nc\n', 'a\nb\nc\n')
    expect(r.clean).toBe(false)
    expect(r.text).toContain('<<<<<<< atual')
    expect(r.text).toContain('||||||| depois do chat')
    expect(r.text).toContain('>>>>>>> revertido')
  })

  it('preserva CRLF e ausência de newline final', async () => {
    const r = await threeWayMerge(
      'l1\r\nl2\r\nl3\r\nX',
      'l1\r\nl2\r\nl3\r\nl4',
      'Y\r\nl2\r\nl3\r\nl4'
    )
    expect(r).toEqual({ clean: true, text: 'Y\r\nl2\r\nl3\r\nX' })
  })
})

describe('revert de três vias', () => {
  let env: Env
  beforeEach(() => {
    env = setup()
  })

  it('caminho direto: ninguém mexeu depois', async () => {
    env.write('c1', 'a.txt', BASE.replace('l2', 'C1'))
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'a.txt' })
    expect(r).toEqual({ status: 'reverted' })
    expect(env.read('a.txt')).toBe(BASE)
    expect(await env.svc.list({ projectId: env.projectId })).toEqual([])
  })

  it('merge limpo quando os chats mexeram em regiões diferentes', async () => {
    env.write('c1', 'a.txt', BASE.replace('l1', 'C1'))
    env.write('c2', 'a.txt', BASE.replace('l1', 'C1').replace('l6', 'C2'))
    env.events.length = 0
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'a.txt' })
    expect(r).toEqual({ status: 'reverted' })
    expect(env.read('a.txt')).toBe(BASE.replace('l6', 'C2'))
    const pending = env.repo.forPath(env.projectId, 'a.txt')
    expect(pending.some((c) => c.chatId === 'c1')).toBe(false)
    const rev = pending.find((c) => c.chatId === null)
    expect(rev?.origin).toBe('tool')
    expect(env.events).toEqual([
      {
        type: 'file_touched',
        projectId: env.projectId,
        chatId: null,
        path: 'a.txt',
        origin: 'tool'
      }
    ])
    const list = await env.svc.list({ projectId: env.projectId })
    expect(list.map((f) => f.path)).toEqual(['a.txt'])
    expect(list[0].chatIds).toEqual(['c2'])
  })

  it('merge limpo com CRLF mantém os fins de linha', async () => {
    const crlf = BASE.replace(/\n/g, '\r\n')
    writeFileSync(join(env.root, 'a.txt'), crlf)
    env.write('c1', 'a.txt', crlf.replace('l1', 'C1'))
    env.write('c2', 'a.txt', crlf.replace('l1', 'C1').replace('l6', 'C2'))
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'a.txt' })
    expect(r.status).toBe('reverted')
    expect(env.read('a.txt')).toBe(crlf.replace('l6', 'C2'))
  })

  it('conflito quando mexeram na mesma linha (não grava nada)', async () => {
    env.write('c1', 'a.txt', BASE.replace('l3', 'C1'))
    env.write('c2', 'a.txt', BASE.replace('l3', 'C2'))
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'a.txt' })
    expect(r.status).toBe('conflict')
    expect(r.message).toBe(REVERT_CONFLICT_MESSAGE)
    expect(r.conflict).toMatchObject({
      path: 'a.txt',
      base: BASE.replace('l3', 'C1'),
      current: BASE.replace('l3', 'C2'),
      reverted: BASE
    })
    expect(r.conflict?.merged).toContain('<<<<<<<')
    expect(env.read('a.txt')).toBe(BASE.replace('l3', 'C2'))
    expect(env.repo.forPath(env.projectId, 'a.txt').filter((c) => c.chatId === 'c1')).toHaveLength(
      1
    )
  })

  it('arquivo criado pelo chat e editado por outro depois → conflito, não apaga', async () => {
    env.write('c1', 'novo.txt', 'x\n')
    env.write('c2', 'novo.txt', 'x\ny\n')
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'novo.txt' })
    expect(r.status).toBe('conflict')
    expect(r.conflict?.reverted).toBe('')
    expect(env.read('novo.txt')).toBe('x\ny\n')
  })

  it('binário alterado depois → conflito sem merged', async () => {
    env.write('c1', 'bin.dat', 'a\0b')
    env.write('c2', 'bin.dat', 'a\0c')
    const r = await env.svc.revert({ projectId: env.projectId, chatId: 'c1', path: 'bin.dat' })
    expect(r).toEqual({ status: 'conflict', message: BINARY_CONFLICT_MESSAGE })
  })

  describe('resolveConflict', () => {
    beforeEach(() => {
      env.write('c1', 'a.txt', BASE.replace('l3', 'C1'))
      env.write('c2', 'a.txt', BASE.replace('l3', 'C2'))
    })

    it('keep-current só marca as mudanças do chat como revisadas', async () => {
      const r = await env.svc.resolveConflict({
        projectId: env.projectId,
        chatId: 'c1',
        path: 'a.txt',
        choice: 'keep-current'
      })
      expect(r).toBeNull()
      expect(env.read('a.txt')).toBe(BASE.replace('l3', 'C2'))
      const pending = env.repo.forPath(env.projectId, 'a.txt')
      expect(pending.map((c) => c.chatId)).toEqual(['c2'])
      const list = await env.svc.list({ projectId: env.projectId })
      expect(list[0].chatIds).toEqual(['c2'])
    })

    it('apply-revert grava antes_chat e marca como revertido', async () => {
      env.events.length = 0
      await env.svc.resolveConflict({
        projectId: env.projectId,
        chatId: 'c1',
        path: 'a.txt',
        choice: 'apply-revert'
      })
      expect(env.read('a.txt')).toBe(BASE)
      expect(env.events).toHaveLength(1)
      // Voltou à base: sem mudança líquida.
      expect(env.repo.forPath(env.projectId, 'a.txt')).toEqual([])
    })

    it('manual grava o conteúdo e registra a mudança', async () => {
      await env.svc.resolveConflict({
        projectId: env.projectId,
        chatId: 'c1',
        path: 'a.txt',
        choice: 'manual',
        content: 'manual\n'
      })
      expect(env.read('a.txt')).toBe('manual\n')
      const pending = env.repo.forPath(env.projectId, 'a.txt')
      expect(pending.some((c) => c.chatId === 'c1')).toBe(false)
      expect(pending.at(-1)).toMatchObject({ chatId: null, origin: 'tool' })
    })

    it('manual sem conteúdo é rejeitado', async () => {
      await expect(
        env.svc.resolveConflict({
          projectId: env.projectId,
          chatId: 'c1',
          path: 'a.txt',
          choice: 'manual'
        })
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    })
  })
})
