import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { EngineEvent } from '../../src/shared/events'
import { openDb, type Db } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { FileChangeRepo } from '../../src/agent-host/repo/fileChanges'
import { createChangeCapture } from '../../src/agent-host/attribution/capture'
import { dirtyPaths, indexContent } from '../../src/agent-host/attribution/gitState'
import type { CaptureMeta, ChangeCapture } from '../../src/agent-host/services/types'

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

interface Env {
  root: string
  db: Db
  blobs: BlobStore
  repo: FileChangeRepo
  capture: ChangeCapture
  events: EngineEvent[]
  meta: CaptureMeta
}

function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jtc-cap-'))
  const root = join(base, 'repo com espaço')
  mkdirSync(root)
  sh(root, 'init', '-q')
  sh(root, 'config', 'user.email', 't@t')
  sh(root, 'config', 'user.name', 't')
  sh(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'limpo.txt'), 'limpo\n')
  writeFileSync(join(root, 'sujo.txt'), 'original\n')
  writeFileSync(join(root, 'apagar.txt'), 'apagar\n')
  writeFileSync(join(root, 'ação.txt'), 'acento\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
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
  const capture = createChangeCapture({ db, blobs, emit: (e) => events.push(e) }, repo)
  const meta = { projectId: 'p1', projectRoot: root, chatId: 'c1', toolCallId: 't1' }
  return { root, db, blobs, repo, capture, events, meta }
}

describe('captura de mudanças', () => {
  let env: Env
  beforeEach(() => {
    env = setup()
  })

  it('comando modifica arquivo limpo: antes vem do índice', async () => {
    const { capture, meta, root, blobs, events } = env
    const { result, changes } = await capture.withCommand(meta, async () => {
      writeFileSync(join(root, 'limpo.txt'), 'mudou\n')
      return 42
    })
    expect(result).toBe(42)
    expect(changes).toHaveLength(1)
    const c = changes[0]
    expect(c).toMatchObject({
      path: 'limpo.txt',
      origin: 'command',
      chatId: 'c1',
      toolCallId: 't1',
      candidateChatIds: [],
      beforeHash: sha('limpo\n'),
      afterHash: sha('mudou\n')
    })
    expect(blobs.get(c.beforeHash as string)?.toString()).toBe('limpo\n')
    expect(blobs.get(c.afterHash as string)?.toString()).toBe('mudou\n')
    expect(events).toEqual([
      { type: 'file_touched', projectId: 'p1', chatId: 'c1', path: 'limpo.txt', origin: 'command' }
    ])
  })

  it('cria arquivo novo (antes null), inclusive com espaço e acento no caminho', async () => {
    const { capture, meta, root } = env
    const { changes } = await capture.withCommand(meta, async () => {
      mkdirSync(join(root, 'pasta nova'))
      writeFileSync(join(root, 'pasta nova', 'açaí.txt'), 'novo')
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'pasta nova/açaí.txt',
      beforeHash: null,
      afterHash: sha('novo')
    })
  })

  it('apaga arquivo rastreado (depois null)', async () => {
    const { capture, meta, root } = env
    const { changes } = await capture.withCommand(meta, async () => {
      rmSync(join(root, 'apagar.txt'))
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'apagar.txt',
      beforeHash: sha('apagar\n'),
      afterHash: null
    })
  })

  it('modifica arquivo já sujo: antes é o conteúdo sujo', async () => {
    const { capture, meta, root } = env
    writeFileSync(join(root, 'sujo.txt'), 'sujo antes\n')
    const { changes } = await capture.withCommand(meta, async () => {
      writeFileSync(join(root, 'sujo.txt'), 'sujo depois\n')
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'sujo.txt',
      beforeHash: sha('sujo antes\n'),
      afterHash: sha('sujo depois\n')
    })
  })

  it('arquivo sujo que não muda durante o comando não é registrado', async () => {
    const { capture, meta, root } = env
    writeFileSync(join(root, 'sujo.txt'), 'sujo antes\n')
    const { changes } = await capture.withCommand(meta, async () => {
      writeFileSync(join(root, 'ação.txt'), 'outro\n')
    })
    expect(changes.map((c) => c.path)).toEqual(['ação.txt'])
  })

  it('saída em pasta ignorada não é registrada', async () => {
    const { capture, meta, root, events } = env
    const { changes } = await capture.withCommand(meta, async () => {
      mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'lixo')
    })
    expect(changes).toEqual([])
    expect(events).toEqual([])
  })

  it('comando sem mudanças devolve []', async () => {
    const { capture, meta } = env
    const { changes } = await capture.withCommand(meta, async () => 'ok')
    expect(changes).toEqual([])
  })

  it('renome registra os dois lados', async () => {
    const { capture, meta, root } = env
    const { changes } = await capture.withCommand(meta, async () => {
      renameSync(join(root, 'limpo.txt'), join(root, 'renomeado.txt'))
      sh(root, 'add', '-A')
    })
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]))
    expect(byPath['limpo.txt']).toMatchObject({ beforeHash: sha('limpo\n'), afterHash: null })
    expect(byPath['renomeado.txt']).toMatchObject({ beforeHash: null, afterHash: sha('limpo\n') })
  })

  it('arquivo alterado e commitado pelo comando é registrado', async () => {
    const { capture, meta, root } = env
    const { changes } = await capture.withCommand(meta, async () => {
      writeFileSync(join(root, 'limpo.txt'), 'commitado\n')
      sh(root, 'commit', '-q', '-am', 'x')
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'limpo.txt',
      beforeHash: sha('limpo\n'),
      afterHash: sha('commitado\n')
    })
  })

  it('erro no comando ainda registra as mudanças e repassa o erro', async () => {
    const { capture, meta, root, repo } = env
    await expect(
      capture.withCommand(meta, async () => {
        writeFileSync(join(root, 'limpo.txt'), 'x')
        throw new Error('falhou')
      })
    ).rejects.toThrow('falhou')
    expect(repo.listUnreviewed('p1').map((c) => c.path)).toEqual(['limpo.txt'])
  })

  it('recordToolWrite grava blobs e emite file_touched; igual → null', () => {
    const { capture, meta, blobs, events } = env
    expect(capture.recordToolWrite(meta, 'a.txt', Buffer.from('x'), Buffer.from('x'))).toBeNull()
    expect(capture.recordToolWrite(meta, 'a.txt', null, null)).toBeNull()
    expect(events).toEqual([])
    const c = capture.recordToolWrite(meta, 'src\\a.txt', null, Buffer.from('novo'))
    expect(c).toMatchObject({
      origin: 'tool',
      path: 'src/a.txt',
      beforeHash: null,
      afterHash: sha('novo'),
      toolCallId: 't1'
    })
    expect(blobs.get(sha('novo'))?.toString()).toBe('novo')
    expect(events).toHaveLength(1)
  })
})

describe('gitState', () => {
  it('dirtyPaths em subpasta do repo devolve caminhos relativos à subpasta', async () => {
    const { root } = setup()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'x.txt'), 'x')
    writeFileSync(join(root, 'fora.txt'), 'y')
    expect(await dirtyPaths(join(root, 'sub'))).toEqual(['x.txt'])
    expect(await dirtyPaths(root)).toEqual(['fora.txt', 'sub/x.txt'])
  })

  it('dirtyPaths fora de repo git devolve []', async () => {
    expect(await dirtyPaths(mkdtempSync(join(tmpdir(), 'jtc-nogit-')))).toEqual([])
  })

  it('indexContent devolve null para arquivo não rastreado', async () => {
    const { root } = setup()
    expect((await indexContent(root, 'limpo.txt'))?.toString()).toBe('limpo\n')
    expect(await indexContent(root, 'nao-existe.txt')).toBeNull()
  })
})

describe('FileChangeRepo', () => {
  it('listUnreviewed, forPath, markReviewed e markReverted', () => {
    const { repo } = setup()
    const base = {
      projectId: 'p1',
      candidateChatIds: ['c1', 'c2'],
      origin: 'command' as const,
      beforeHash: null,
      afterHash: 'h',
      toolCallId: null
    }
    const a = repo.insert({ ...base, chatId: 'c1', path: 'a.txt' })
    const b = repo.insert({ ...base, chatId: 'c2', path: 'a.txt' })
    const c = repo.insert({ ...base, chatId: 'c1', path: 'b.txt' })
    expect(a.candidateChatIds).toEqual(['c1', 'c2'])
    expect(repo.listUnreviewed('p1').map((x) => x.id)).toEqual([a.id, b.id, c.id])
    expect(repo.listUnreviewed('p1', 'c1').map((x) => x.id)).toEqual([a.id, c.id])
    expect(repo.forPath('p1', 'a.txt').map((x) => x.id)).toEqual([a.id, b.id])
    repo.markReviewed([a.id])
    repo.markReverted([c.id])
    expect(repo.listUnreviewed('p1').map((x) => x.id)).toEqual([b.id])
    expect(repo.forPath('p1', 'a.txt').map((x) => x.id)).toEqual([b.id])
    expect(repo.get(a.id)?.reviewedAt).toEqual(expect.any(Number))
    expect(repo.get(c.id)?.revertedAt).toEqual(expect.any(Number))
  })
})
