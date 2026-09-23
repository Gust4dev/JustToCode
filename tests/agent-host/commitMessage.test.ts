import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { gitHandlers } from '../../src/agent-host/handlers/git'
import {
  cleanCommitMessage,
  truncateDiff,
  MAX_DIFF_CHARS
} from '../../src/agent-host/git/commitMessage'
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/domain'
import type { HostContext } from '../../src/agent-host/context'
import { chunk, startFakeRouter, type FakeRouter } from '../helpers/fakeRouter'

function gitRun(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    {
      cwd: root,
      encoding: 'utf8'
    }
  )
}

interface Env {
  root: string
  projectId: string
  router: FakeRouter
  cfg: AppConfig
  call: () => Promise<{ message: string; staged: boolean; model: string }>
}

let reply = 'feat: default'
let env: Env
let db: Db

beforeEach(async () => {
  reply = 'feat: default'
  const base = mkdtempSync(join(tmpdir(), 'jtc-cm-'))
  const root = join(base, 'repo')
  mkdirSync(root)
  gitRun(root, 'init', '-q')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  gitRun(root, 'add', '.')
  gitRun(root, 'commit', '-q', '-m', 'feat: primeiro commit')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
  gitRun(root, 'commit', '-q', '-am', 'fix: segundo commit')

  db = openDb(join(base, 'db.sqlite'))
  const projects = new ProjectRepo(db)
  const projectId = projects.create(root, 'repo').id
  const router = await startFakeRouter(() => ({
    chunks: [chunk.text(reply), chunk.finish('stop')]
  }))
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    routerBaseUrl: router.url,
    defaultCombo: 'combo/default',
    lightCombo: 'combo/light'
  }
  const model = createOpenAiClient(() => cfg)
  const handlers = gitHandlers({ projects, model, getConfig: () => cfg })({
    db
  } as unknown as HostContext)
  const call = (): Promise<{ message: string; staged: boolean; model: string }> =>
    handlers['git.commitMessage']({ projectId }) as Promise<{
      message: string
      staged: boolean
      model: string
    }>
  env = { root, projectId, router, cfg, call }
})

afterEach(async () => {
  await env.router.close()
  db.close()
})

const userPrompt = (): string => {
  const body = env.router.requests.at(-1)
  return body.messages.find((m: { role: string }) => m.role === 'user').content as string
}

describe('git.commitMessage', () => {
  it('staged tem prioridade sobre a working tree', async () => {
    writeFileSync(join(env.root, 'staged.txt'), 'STAGED_CONTENT\n')
    gitRun(env.root, 'add', 'staged.txt')
    writeFileSync(join(env.root, 'a.txt'), 'one\ntwo\nWORKTREE_CHANGE\n')
    writeFileSync(join(env.root, 'loose.txt'), 'UNTRACKED_CONTENT\n')

    const r = await env.call()
    expect(r.staged).toBe(true)
    expect(r.message).toBe('feat: default')
    expect(r.model).toBe('combo/light')
    const prompt = userPrompt()
    expect(prompt).toContain('STAGED_CONTENT')
    expect(prompt).toContain('staged.txt')
    expect(prompt).not.toContain('WORKTREE_CHANGE')
    expect(prompt).not.toContain('UNTRACKED_CONTENT')
  })

  it('sem staged usa working tree e não rastreados', async () => {
    writeFileSync(join(env.root, 'a.txt'), 'one\ntwo\nWORKTREE_CHANGE\n')
    const long = Array.from({ length: 80 }, (_, i) => `line${i + 1}`).join('\n')
    writeFileSync(join(env.root, 'new.txt'), `UNTRACKED_CONTENT\n${long}\n`)

    const r = await env.call()
    expect(r.staged).toBe(false)
    const prompt = userPrompt()
    expect(prompt).toContain('WORKTREE_CHANGE')
    expect(prompt).toContain('new.txt')
    expect(prompt).toContain('UNTRACKED_CONTENT')
    expect(prompt).toContain('line49')
    expect(prompt).not.toContain('line50\n')
    expect(prompt).not.toContain('line60')
  })

  it('só não rastreados também gera (staged: false)', async () => {
    writeFileSync(join(env.root, 'only.txt'), 'hello\n')
    const r = await env.call()
    expect(r.staged).toBe(false)
    expect(userPrompt()).toContain('only.txt')
  })

  it('limpa cercas e aspas externas', async () => {
    writeFileSync(join(env.root, 'a.txt'), 'changed\n')
    reply = '```text\n"feat: add thing\n\n- detail"\n```'
    const r = await env.call()
    expect(r.message).toBe('feat: add thing\n\n- detail')
  })

  it('NOTHING_TO_COMMIT quando não há mudanças', async () => {
    await expect(env.call()).rejects.toMatchObject({ code: 'NOTHING_TO_COMMIT' })
    expect(env.router.requests).toHaveLength(0)
  })

  it('o request contém o log como exemplo de estilo', async () => {
    writeFileSync(join(env.root, 'a.txt'), 'changed\n')
    await env.call()
    const prompt = userPrompt()
    expect(prompt).toContain('feat: primeiro commit')
    expect(prompt).toContain('fix: segundo commit')
    expect(env.router.requests.at(-1).model).toBe('combo/light')
  })

  it('sem lightCombo usa a combo padrão', async () => {
    env.cfg.lightCombo = ''
    writeFileSync(join(env.root, 'a.txt'), 'changed\n')
    const r = await env.call()
    expect(r.model).toBe('combo/default')
  })

  it('nunca commita', async () => {
    writeFileSync(join(env.root, 'x.txt'), 'x\n')
    gitRun(env.root, 'add', 'x.txt')
    await env.call()
    expect(gitRun(env.root, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
  })
})

describe('helpers', () => {
  it('cleanCommitMessage sem cerca mantém o texto', () => {
    expect(cleanCommitMessage('  fix: x  ')).toBe('fix: x')
    expect(cleanCommitMessage("'fix: y'")).toBe('fix: y')
    expect(cleanCommitMessage('```\nfix: z\n```')).toBe('fix: z')
  })

  it('truncateDiff corta por arquivo com aviso', () => {
    const section = (name: string, size: number): string =>
      `diff --git a/${name} b/${name}\n+${'x'.repeat(size)}\n`
    const diff =
      section('small.ts', 100) + section('big.ts', MAX_DIFF_CHARS) + section('late.ts', 50)
    const out = truncateDiff(diff)
    expect(out.length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 200)
    expect(out).toContain('diff --git a/small.ts')
    expect(out).toMatch(/diff of big\.ts truncated/)
    expect(out).toMatch(/omitted for 1 file\(s\): late\.ts/)
    expect(truncateDiff('short')).toBe('short')
  })
})
