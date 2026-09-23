import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/agent-host/db'
import { ComboOverrideRepo } from '../../src/agent-host/repo/comboOverrides'
import { ModelWindowRepo } from '../../src/agent-host/repo/modelWindows'
import { createComboResolver } from '../../src/agent-host/context/comboResolver'
import { readRouterCombos } from '../../src/agent-host/context/routerDb'
import { comboHandlers } from '../../src/agent-host/handlers/combos'
import type { HostContext } from '../../src/agent-host/context'
import { DEFAULT_CONFIG, type AppConfig, type ModelInfo } from '../../src/shared/domain'

const model = (id: string, contextWindow: number | null, isCombo = false): ModelInfo => ({
  id,
  ownedBy: 'x',
  isCombo,
  contextWindow,
  maxOutput: null,
  vision: false,
  tools: true
})

function makeRouterDb(combos: Record<string, string[]>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'jtc-router-')), 'data.sqlite')
  const db = new Database(path)
  db.exec(
    'create table combos (id text primary key, name text, kind text, models text, createdAt text, updatedAt text)'
  )
  const ins = db.prepare('insert into combos values (?, ?, ?, ?, ?, ?)')
  for (const [name, models] of Object.entries(combos))
    ins.run(name, name, 'fallback', JSON.stringify(models), 'now', 'now')
  db.close()
  return path
}

let db: Db
let overrides: ComboOverrideRepo
let windows: ModelWindowRepo
let models: ModelInfo[]
let cfg: AppConfig

const resolver = (): ReturnType<typeof createComboResolver> =>
  createComboResolver({
    listModels: async () => models,
    overrides,
    windows,
    getConfig: () => cfg
  })

beforeEach(() => {
  db = openDb(':memory:')
  overrides = new ComboOverrideRepo(db)
  windows = new ModelWindowRepo(db)
  models = [
    model('dev', null, true),
    model('a', 200_000),
    model('b', 64_000),
    model('c', 128_000),
    model('solo', 32_000)
  ]
  cfg = {
    ...DEFAULT_CONFIG,
    routerDbPath: makeRouterDb({ dev: ['a', 'b', 'c'] }),
    unknownWindowFallback: 128_000
  }
})

describe('ComboResolver', () => {
  it('lê membros do DB do 9router e calcula o mínimo', async () => {
    const i = await resolver().info('dev')
    expect(i).toMatchObject({
      combo: 'dev',
      isCombo: true,
      members: ['a', 'b', 'c'],
      source: 'router-db',
      effectiveWindow: 64_000,
      limitingModel: 'b',
      warning: null
    })
    expect(i.windows).toEqual({ a: 200_000, b: 64_000, c: 128_000 })
  })

  it('membro ignorado muda o mínimo', async () => {
    overrides.set('dev', { ignored: ['b'] })
    const i = await resolver().info('dev')
    expect(i.ignored).toEqual(['b'])
    expect(i.effectiveWindow).toBe(128_000)
    expect(i.limitingModel).toBe('c')
  })

  it('override de janela vence tudo', async () => {
    overrides.set('dev', { windowOverride: 50_000 })
    expect(await resolver().effectiveWindow('dev')).toEqual({
      window: 50_000,
      limitingModel: 'manual'
    })
  })

  it('override manual de membros vence o DB', async () => {
    overrides.set('dev', { members: ['a', 'c'] })
    const i = await resolver().info('dev')
    expect(i).toMatchObject({ members: ['a', 'c'], source: 'manual', effectiveWindow: 128_000 })
  })

  it('model_windows sobrepõe a janela do listModels', async () => {
    windows.set('b', 300_000)
    const i = await resolver().info('dev')
    expect(i.windows.b).toBe(300_000)
    expect(i.limitingModel).toBe('c')
    windows.set('b', null)
    expect(windows.get('b')).toBeNull()
  })

  it('DB ausente → unknown + warning, sem lançar', async () => {
    cfg.routerDbPath = join(tmpdir(), 'nao-existe-jtc', 'data.sqlite')
    const i = await resolver().info('dev')
    expect(i.source).toBe('unknown')
    expect(i.members).toEqual([])
    expect(i.warning).toContain('Defina manualmente')
    expect(i.effectiveWindow).toBe(128_000)
    expect(i.limitingModel).toBeNull()
  })

  it('schema diferente (sem coluna models) → warning, sem lançar', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jtc-router-')), 'data.sqlite')
    const other = new Database(path)
    other.exec('create table combos (id text, name text)')
    other.prepare('insert into combos values (?, ?)').run('dev', 'dev')
    other.close()
    cfg.routerDbPath = path
    expect(readRouterCombos(path).error).toBeTruthy()
    const i = await resolver().info('dev')
    expect(i.source).toBe('unknown')
    expect(i.warning).toMatch(/models/)
  })

  it('JSON inválido → erro curto, sem lançar', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jtc-router-')), 'data.sqlite')
    const bad = new Database(path)
    bad.exec('create table combos (name text, models text)')
    bad.prepare('insert into combos values (?, ?)').run('dev', '{nope')
    bad.close()
    const r = readRouterCombos(path)
    expect(r.combos).toEqual({})
    expect(r.error).toBeTruthy()
  })

  it('membro sem janela → fallback 128000 + warning', async () => {
    cfg.routerDbPath = makeRouterDb({ dev: ['a', 'mystery'] })
    cfg.unknownWindowFallback = 100_000
    const i = await resolver().info('dev')
    expect(i.windows.mystery).toBeNull()
    expect(i.effectiveWindow).toBe(100_000)
    expect(i.limitingModel).toBe('mystery')
    expect(i.warning).toContain('Janela desconhecida para mystery')
    cfg.unknownWindowFallback = 128_000
    const j = await resolver().info('dev')
    expect(j.effectiveWindow).toBe(128_000)
  })

  it('modelo não-combo usa a própria janela', async () => {
    const i = await resolver().info('solo')
    expect(i).toMatchObject({
      isCombo: false,
      members: ['solo'],
      source: 'model',
      effectiveWindow: 32_000,
      limitingModel: 'solo'
    })
  })

  it('cacheia listModels por 5 min e invalida', async () => {
    let calls = 0
    let t = 0
    const r = createComboResolver({
      listModels: async () => {
        calls++
        return models
      },
      overrides,
      windows,
      getConfig: () => cfg,
      now: () => t
    })
    await r.info('solo')
    await r.info('solo')
    expect(calls).toBe(1)
    t = 5 * 60_000 + 1
    await r.info('solo')
    expect(calls).toBe(2)
    r.invalidate()
    await r.info('solo')
    expect(calls).toBe(3)
  })

  it('routerDb nunca escreve (mtime e conteúdo iguais)', async () => {
    const path = cfg.routerDbPath
    const before = statSync(path).mtimeMs
    const bytes = readFileSync(path)
    await new Promise((r) => setTimeout(r, 20))
    expect(readRouterCombos(path).combos.dev).toEqual(['a', 'b', 'c'])
    await resolver().info('dev')
    expect(statSync(path).mtimeMs).toBe(before)
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })
})

describe('comboHandlers', () => {
  it('setOverride grava, limpa membros com null e devolve info; setWindow grava/apaga', async () => {
    const r = resolver()
    const h = comboHandlers({ resolver: r, overrides, windows })({} as HostContext)
    const set = h['combos.setOverride'] as (p: unknown) => Promise<{ source: string }>
    expect((await set({ combo: 'dev', members: ['a'] })).source).toBe('manual')
    expect((await set({ combo: 'dev', members: null })).source).toBe('router-db')
    await (h['models.setWindow'] as (p: unknown) => unknown)({ modelId: 'b', contextWindow: 10 })
    const info = (await (h['combos.info'] as (p: unknown) => Promise<{ effectiveWindow: number }>)({
      combo: 'dev'
    })) as { effectiveWindow: number }
    expect(info.effectiveWindow).toBe(10)
    await (h['models.setWindow'] as (p: unknown) => unknown)({ modelId: 'b', contextWindow: null })
    expect(windows.get('b')).toBeNull()
  })
})
