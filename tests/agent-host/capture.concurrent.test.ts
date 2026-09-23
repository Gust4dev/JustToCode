import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { EngineEvent } from '../../src/shared/events'
import type { FileChange } from '../../src/shared/domain'
import { openDb, type Db } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { FileChangeRepo } from '../../src/agent-host/repo/fileChanges'
import { createChangeCapture } from '../../src/agent-host/attribution/capture'
import {
  CommandWindowRegistry,
  RecentToolWrites
} from '../../src/agent-host/attribution/commandWindows'
import { createProjectWatcher, type ProjectWatcher } from '../../src/agent-host/attribution/watcher'
import type { CaptureMeta, ChangeCapture } from '../../src/agent-host/services/types'

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

interface Env {
  base: string
  root: string
  db: Db
  repo: FileChangeRepo
  capture: ChangeCapture
  registry: CommandWindowRegistry
  toolWrites: RecentToolWrites
  blobs: BlobStore
  events: EngineEvent[]
  meta: (chatId: string, toolCallId?: string) => CaptureMeta
  watcher: ProjectWatcher | null
}

function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jtc-conc-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  sh(root, 'init', '-q')
  sh(root, 'config', 'user.email', 't@t')
  sh(root, 'config', 'user.name', 't')
  sh(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  writeFileSync(join(root, 'b.txt'), 'b\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nbuild/\n*.log\n')
  sh(root, 'add', '.')
  sh(root, 'commit', '-q', '-m', 'init')

  const db = openDb(join(base, 'db.sqlite'))
  db.prepare('insert into projects (id, path, name, created_at) values (?, ?, ?, ?)').run(
    'p1',
    root,
    'p',
    Date.now()
  )
  const blobs = new BlobStore(join(base, 'blobs'))
  const repo = new FileChangeRepo(db)
  const events: EngineEvent[] = []
  const registry = new CommandWindowRegistry()
  const toolWrites = new RecentToolWrites()
  const ctx = { db, blobs, emit: (e: EngineEvent) => events.push(e) }
  const capture = createChangeCapture(ctx, repo, { registry, toolWrites })
  const meta = (chatId: string, toolCallId = `t-${chatId}`): CaptureMeta => ({
    projectId: 'p1',
    projectRoot: root,
    chatId,
    toolCallId
  })
  return { base, root, db, repo, capture, registry, toolWrites, blobs, events, meta, watcher: null }
}

async function startWatcher(env: Env): Promise<ProjectWatcher> {
  const watcher = createProjectWatcher({
    ctx: { db: env.db, blobs: env.blobs, emit: (e) => env.events.push(e) },
    repo: env.repo,
    registry: env.registry,
    toolWrites: env.toolWrites,
    blobs: env.blobs,
    debounceMs: 200
  })
  env.watcher = watcher
  await watcher.start('p1', env.root)
  return watcher
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const byPath = (repo: FileChangeRepo, path: string): FileChange[] =>
  repo.listUnreviewed('p1').filter((c) => c.path === path)

describe('CommandWindowRegistry', () => {
  it('sobreposição só com outros chats e intervalos que se cruzam', () => {
    let now = 100
    const reg = new CommandWindowRegistry(() => now)
    const a = reg.open({ projectId: 'p1', chatId: 'c1', toolCallId: 't1' })
    now = 110
    const same = reg.open({ projectId: 'p1', chatId: 'c1', toolCallId: 't2' })
    const other = reg.open({ projectId: 'p2', chatId: 'c9', toolCallId: 't9' })
    now = 120
    reg.close(same.id)
    reg.close(other.id)
    expect(reg.overlapping('p1', a)).toEqual([])
    const b = reg.open({ projectId: 'p1', chatId: 'c2', toolCallId: 't3' })
    expect(reg.overlapping('p1', a).map((w) => w.chatId)).toEqual(['c2'])
    now = 130
    reg.close(a.id)
    now = 140
    reg.close(b.id)
    // c depois de a/b fecharem: sem sobreposição
    now = 150
    const c = reg.open({ projectId: 'p1', chatId: 'c3', toolCallId: 't4' })
    expect(reg.overlapping('p1', c)).toEqual([])
    expect(
      reg
        .activeAt('p1', 125)
        .map((w) => w.chatId)
        .sort()
    ).toEqual(['c1', 'c2'])
    expect(reg.activeAt('p1', 145).map((w) => w.chatId)).toEqual([])
    expect(reg.activeAt('p1', 150).map((w) => w.chatId)).toEqual(['c3'])
  })

  it('RecentToolWrites compara hash e prazo', () => {
    let now = 0
    const tw = new RecentToolWrites(() => now)
    tw.mark('p1', 'x.txt', 'h1')
    expect(tw.isRecent('p1', 'x.txt', 'h1')).toBe(true)
    expect(tw.isRecent('p1', 'x.txt', 'h2')).toBe(false)
    now = 10_000
    expect(tw.isRecent('p1', 'x.txt', 'h1')).toBe(false)
  })
})

describe('atribuição concorrente', () => {
  let env: Env
  beforeEach(() => {
    env = setup()
  })
  afterEach(async () => {
    await env.watcher?.stopAll()
    env.db.close()
    try {
      rmSync(env.base, { recursive: true, force: true })
    } catch {
      // Windows pode segurar o diretório por alguns instantes.
    }
  })

  it('dois comandos sobrepostos de chats diferentes → ambiguous com os dois candidatos', async () => {
    const { capture, meta, root, repo } = env
    const bStarted = deferred()
    const releaseA = deferred()
    const pa = capture.withCommand(meta('c1'), async () => {
      await bStarted.promise
      await releaseA.promise
      return 'a'
    })
    const pb = capture.withCommand(meta('c2'), async () => {
      bStarted.resolve()
      writeFileSync(join(root, 'a.txt'), 'mudou\n')
      return 'b'
    })
    const rb = await pb
    releaseA.resolve()
    const ra = await pa

    expect(rb.changes).toHaveLength(1)
    expect(rb.changes[0]).toMatchObject({
      path: 'a.txt',
      origin: 'ambiguous',
      chatId: null,
      beforeHash: sha('a\n'),
      afterHash: sha('mudou\n')
    })
    expect(rb.changes[0].candidateChatIds.sort()).toEqual(['c1', 'c2'])
    // A também viu a mudança, mas ela já foi registrada durante a janela dele: sem duplicata.
    expect(ra.changes).toHaveLength(0)
    expect(byPath(repo, 'a.txt')).toHaveLength(1)
  })

  it('comandos não sobrepostos → cada um com seu chat', async () => {
    const { capture, meta, root, repo } = env
    await capture.withCommand(meta('c1'), async () => {
      writeFileSync(join(root, 'a.txt'), 'um\n')
    })
    await capture.withCommand(meta('c2'), async () => {
      writeFileSync(join(root, 'b.txt'), 'dois\n')
    })
    expect(byPath(repo, 'a.txt')).toEqual([
      expect.objectContaining({ origin: 'command', chatId: 'c1', candidateChatIds: [] })
    ])
    expect(byPath(repo, 'b.txt')).toEqual([
      expect.objectContaining({ origin: 'command', chatId: 'c2', candidateChatIds: [] })
    ])
  })

  it('ferramenta de outro chat durante o comando não é reatribuída ao comando', async () => {
    const { capture, meta, root, repo } = env
    await capture.withCommand(meta('c1'), async () => {
      writeFileSync(join(root, 'b.txt'), 'ferramenta\n')
      capture.recordToolWrite(
        meta('c2', 'tool-1'),
        'b.txt',
        Buffer.from('b\n'),
        Buffer.from('ferramenta\n')
      )
    })
    expect(byPath(repo, 'b.txt')).toEqual([
      expect.objectContaining({ origin: 'tool', chatId: 'c2' })
    ])
  })
})

describe('watcher de projeto', { timeout: 60_000 }, () => {
  let env: Env
  beforeEach(() => {
    env = setup()
  })
  afterEach(async () => {
    await env.watcher?.stopAll()
    env.db.close()
    try {
      rmSync(env.base, { recursive: true, force: true })
    } catch {
      // Windows pode segurar o diretório por alguns instantes.
    }
  })

  it('edição externa → origin external com before/after e file_touched', async () => {
    const { root, repo, events } = env
    await startWatcher(env)
    writeFileSync(join(root, 'a.txt'), 'do usuário\n')
    const [c] = await waitFor(() => {
      const l = byPath(repo, 'a.txt')
      return l.length > 0 && l
    })
    expect(c).toMatchObject({
      origin: 'external',
      chatId: null,
      beforeHash: sha('a\n'),
      afterHash: sha('do usuário\n'),
      toolCallId: null
    })
    expect(env.blobs.get(sha('do usuário\n'))?.toString()).toBe('do usuário\n')
    expect(events).toContainEqual({
      type: 'file_touched',
      projectId: 'p1',
      chatId: null,
      path: 'a.txt',
      origin: 'external'
    })
  })

  it('arquivo novo externo tem before null; depois compara com o último after', async () => {
    const { root, repo } = env
    await startWatcher(env)
    writeFileSync(join(root, 'novo.txt'), 'v1\n')
    await waitFor(() => byPath(repo, 'novo.txt').length === 1)
    expect(byPath(repo, 'novo.txt')[0]).toMatchObject({ beforeHash: null, afterHash: sha('v1\n') })
    writeFileSync(join(root, 'novo.txt'), 'v2\n')
    await waitFor(() => byPath(repo, 'novo.txt').length === 2)
    expect(byPath(repo, 'novo.txt')[1]).toMatchObject({
      origin: 'external',
      beforeHash: sha('v1\n'),
      afterHash: sha('v2\n')
    })
  })

  it('escrita por ferramenta e por comando não gera external duplicado', async () => {
    const { root, repo, capture, meta } = env
    await startWatcher(env)
    writeFileSync(join(root, 'a.txt'), 'ferramenta\n')
    capture.recordToolWrite(meta('c1'), 'a.txt', Buffer.from('a\n'), Buffer.from('ferramenta\n'))
    await capture.withCommand(meta('c2'), async () => {
      writeFileSync(join(root, 'b.txt'), 'comando\n')
    })
    // Sentinela: quando ela aparecer, os eventos anteriores já foram processados.
    writeFileSync(join(root, 'sentinela.txt'), 'ok\n')
    await waitFor(() => byPath(repo, 'sentinela.txt').length === 1)
    await new Promise((r) => setTimeout(r, 500))
    expect(byPath(repo, 'a.txt').map((c) => c.origin)).toEqual(['tool'])
    expect(byPath(repo, 'b.txt').map((c) => c.origin)).toEqual(['command'])
  })

  it('node_modules, .git e arquivos ignorados pelo git não geram nada', async () => {
    const { root, repo } = env
    await startWatcher(env)
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'out.txt'), 'x')
    writeFileSync(join(root, 'debug.log'), 'x')
    sh(root, 'tag', 'v0')
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(root, 'sentinela.txt'), 'ok\n')
    await waitFor(() => byPath(repo, 'sentinela.txt').length === 1)
    await new Promise((r) => setTimeout(r, 500))
    expect(repo.listUnreviewed('p1').map((c) => c.path)).toEqual(['sentinela.txt'])
  })
})
