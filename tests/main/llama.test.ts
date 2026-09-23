import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LlamaManager,
  parseReleases,
  registerLlama,
  systemTar,
  type LlamaDeps
} from '../../src/main/components/llama'
import {
  ProfileStore,
  buildArgs,
  defaultProfile,
  isGgufModelPath,
  splitArgs
} from '../../src/main/components/profiles'
import { download } from '../../src/main/components/downloader'
import { createComponentsContext } from '../../src/main/components/context'
import type { ComponentHandlers } from '../../src/main/components/ipc'
import type { ProcessSupervisor, SpawnSpec } from '../../src/main/components/supervisor'
import type { LlamaProfile } from '../../src/shared/components'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jtc-llama-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function profile(over: Partial<LlamaProfile> = {}): LlamaProfile {
  return { ...defaultProfile(), id: 'p1', name: 'Qwen', modelPath: 'C:\\m\\q.gguf', ...over }
}

class FakeSupervisor {
  pid: number | null = null
  started: SpawnSpec[] = []
  stopped = 0
  managedPid(): number | null {
    return this.pid
  }
  async start(spec: SpawnSpec): Promise<number> {
    this.started.push(spec)
    this.pid = 4242
    return 4242
  }
  async stop(): Promise<void> {
    this.stopped++
    this.pid = null
  }
}

function asset(name: string, digest?: string): Record<string, unknown> {
  return {
    name,
    browser_download_url: `https://example.invalid/${name}`,
    size: 100,
    ...(digest ? { digest } : {})
  }
}
function winAssets(tag: string, backends: string[], cudart = true): Record<string, unknown>[] {
  const a = backends.map((b) => asset(`llama-${tag}-bin-win-${b}-x64.zip`))
  a.push(
    asset(`llama-${tag}-bin-win-cuda-13.4-arm64.zip`),
    asset(`llama-${tag}-bin-ubuntu-x64.zip`)
  )
  if (cudart) {
    a.push(
      asset('cudart-llama-bin-win-cuda-12.4-x64.zip', `sha256:${'A'.repeat(64)}`),
      asset('cudart-llama-bin-win-cuda-13.4-x64.zip')
    )
  }
  return a
}
const ALL = ['cuda-12.4', 'cuda-13.4', 'vulkan', 'cpu']

const FIXTURE = [
  { tag_name: 'b106', draft: true, prerelease: true, assets: winAssets('b106', ALL) },
  { tag_name: 'b104', prerelease: true, assets: [] }, // release sem assets
  { tag_name: 'b105', prerelease: true, assets: winAssets('b105', ALL) }, // fora de ordem
  { tag_name: 'b103', prerelease: true, assets: winAssets('b103', ['cuda-12.4', 'vulkan'], false) },
  { tag_name: 'b102', prerelease: true, assets: winAssets('b102', ALL) },
  { tag_name: 'b101', prerelease: true, assets: winAssets('b101', ALL) },
  { tag_name: 'b100', prerelease: true, assets: winAssets('b100', ALL) },
  { tag_name: 'b99', prerelease: true } // sem campo assets
]

describe('buildArgs / splitArgs', () => {
  it('monta os argumentos completos', () => {
    const p = profile({ nCpuMoe: 12, extraArgs: '--jinja --alias "meu modelo" -t 8' })
    expect(buildArgs(p)).toEqual([
      '-m',
      'C:\\m\\q.gguf',
      '-c',
      '32768',
      '-ngl',
      '99',
      '--port',
      '8080',
      '--host',
      '127.0.0.1',
      '-fa',
      'on',
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--n-cpu-moe',
      '12',
      '--jinja',
      '--alias',
      'meu modelo',
      '-t',
      '8'
    ])
  })

  it('omite -fa e --n-cpu-moe quando desligados', () => {
    const a = buildArgs(profile({ flashAttn: false, nCpuMoe: null, cacheType: 'f16', ctx: 8192 }))
    expect(a).not.toContain('-fa')
    expect(a).not.toContain('--n-cpu-moe')
    expect(a.slice(0, 4)).toEqual(['-m', 'C:\\m\\q.gguf', '-c', '8192'])
    expect(a.slice(-4)).toEqual(['--cache-type-k', 'f16', '--cache-type-v', 'f16'])
  })

  it('splitArgs respeita aspas e rejeita aspas abertas', () => {
    expect(splitArgs('  a  "b c" \'d e\' f""g "" ')).toEqual(['a', 'b c', 'd e', 'fg', ''])
    expect(splitArgs('')).toEqual([])
    expect(() => splitArgs('--x "abc')).toThrow(/aspas/)
  })
})

describe('parseReleases', () => {
  it('seleciona as 3 mais recentes por backend, com cudart para CUDA', () => {
    const rels = parseReleases(FIXTURE)
    const by = (b: string): string[] => rels.filter((r) => r.backend === b).map((r) => r.tag)
    // b106 é draft; b104/b99 sem assets; b103 sem cudart → fora de CUDA mas vale para vulkan.
    expect(by('cuda-12.4')).toEqual(['b105', 'b102', 'b101'])
    expect(by('cuda-13.4')).toEqual(['b105', 'b102', 'b101'])
    expect(by('vulkan')).toEqual(['b105', 'b103', 'b102'])
    expect(by('cpu')).toEqual(['b105', 'b102', 'b101'])

    const cuda = rels.find((r) => r.backend === 'cuda-12.4')!
    expect(cuda.assets.map((a) => a.name)).toEqual([
      'llama-b105-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip'
    ])
    expect(cuda.assets[0].sha256).toBeNull()
    expect(cuda.assets[1].sha256).toBe('a'.repeat(64))
    expect(cuda.assets[0].url).toBe('https://example.invalid/llama-b105-bin-win-cuda-12.4-x64.zip')

    const vk = rels.find((r) => r.backend === 'vulkan')!
    expect(vk.assets).toHaveLength(1)
  })

  it('JSON inesperado → erro', () => {
    expect(() => parseReleases({ message: 'rate limit' })).toThrow(/inesperada/)
  })
})

describe('perfis', () => {
  it('cria o perfil padrão na primeira vez, valida e faz CRUD', async () => {
    const model = join(dir, 'm.gguf')
    writeFileSync(model, 'x')
    const store = new ProfileStore(join(dir, 'llama', 'profiles.json'))

    const first = await store.list()
    expect(first).toEqual([defaultProfile()])
    expect(first[0]).toMatchObject({
      ctx: 32768,
      nCpuMoe: null,
      ngl: 99,
      flashAttn: true,
      cacheType: 'q8_0',
      port: 8080,
      modelPath: ''
    })

    await expect(store.save({ ...first[0], modelPath: '' })).rejects.toThrow(/\.gguf/)
    await expect(store.save({ ...first[0], modelPath: join(dir, 'nao.gguf') })).rejects.toThrow(
      /não encontrado/
    )
    await expect(store.save({ ...first[0], modelPath: model, port: 80 })).rejects.toThrow(/porta/)
    await expect(store.save({ ...first[0], modelPath: model, port: 70000 })).rejects.toThrow(
      /porta/
    )

    const upd = await store.save({ ...first[0], modelPath: model })
    expect(upd.id).toBe('default')
    const created = await store.save({ ...first[0], id: '', name: '  Outro ', modelPath: model })
    expect(created.id).not.toBe('')
    expect(created.name).toBe('Outro')

    const list = await store.list()
    expect(list.map((p) => p.id)).toEqual(['default', created.id])
    expect(list[0].modelPath).toBe(model)

    await store.remove('default')
    expect(
      (await new ProfileStore(join(dir, 'llama', 'profiles.json')).list()).map((p) => p.id)
    ).toEqual([created.id])
  })

  it('aceita só .gguf simples ou o primeiro shard', () => {
    expect(isGgufModelPath('C:\\m\\a.gguf')).toBe(true)
    expect(isGgufModelPath('C:\\m\\a-00001-of-00003.gguf')).toBe(true)
    expect(isGgufModelPath('C:\\m\\a-00002-of-00003.gguf')).toBe(false)
    expect(isGgufModelPath('C:\\m\\a.bin')).toBe(false)
  })
})

describe('install (servidor local + zip de fixture)', () => {
  let server: Server
  let base: string
  let apiHits = 0
  const files = new Map<string, Buffer>()

  function makeZip(name: string, content: Record<string, string>): Buffer {
    const src = join(dir, `src-${name}`)
    mkdirSync(src, { recursive: true })
    for (const [f, c] of Object.entries(content)) writeFileSync(join(src, f), c)
    const zip = join(dir, name)
    execFileSync(systemTar(), ['-a', '-cf', zip, '-C', src, ...Object.keys(content)])
    return readFileSync(zip)
  }

  beforeEach(async () => {
    apiHits = 0
    files.clear()
    files.set(
      'llama-b200-bin-win-cuda-12.4-x64.zip',
      makeZip('llama-b200-bin-win-cuda-12.4-x64.zip', {
        'llama-server.exe': '@echo off\r\necho falso\r\n',
        'ggml.dll': 'x'
      })
    )
    files.set(
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
      makeZip('cudart-llama-bin-win-cuda-12.4-x64.zip', { 'cudart64_12.dll': 'y' })
    )
    server = createServer((req, res) => {
      if (req.url === '/releases') {
        apiHits++
        const assets = [...files.entries()].map(([name, buf]) => ({
          name,
          browser_download_url: `${base}/files/${name}`,
          size: buf.length,
          digest: `sha256:${createHash('sha256').update(buf).digest('hex')}`
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify([{ tag_name: 'b200', prerelease: true, assets }]))
        return
      }
      const buf = req.url?.startsWith('/files/') ? files.get(req.url.slice(7)) : undefined
      if (!buf) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Length': buf.length })
      res.end(buf)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  function manager(sup = new FakeSupervisor(), over: Partial<LlamaDeps> = {}): LlamaManager {
    return new LlamaManager({
      userData: dir,
      supervisor: sup,
      startDownload: (p) => download({ ...p, onProgress: () => undefined }),
      emitLog: () => undefined,
      releasesUrl: `${base}/releases`,
      health: async () => false,
      ...over
    })
  }

  it('baixa, extrai, grava current.json e apaga os zips', async () => {
    const m = manager()
    expect((await m.status()).installed).toBe(false)
    await m.install('cuda-12.4')

    const target = join(dir, 'llama', 'b200-cuda-12.4')
    const cur = JSON.parse(readFileSync(join(dir, 'llama', 'current.json'), 'utf8'))
    expect(cur).toEqual({ tag: 'b200', backend: 'cuda-12.4', dir: target })
    expect(existsSync(join(target, 'llama-server.exe'))).toBe(true)
    expect(existsSync(join(target, 'cudart64_12.dll'))).toBe(true)
    for (const name of files.keys()) {
      expect(existsSync(join(dir, 'llama', '_downloads', name))).toBe(false)
    }

    const s = await m.status()
    expect(s).toMatchObject({
      id: 'llama',
      installed: true,
      version: 'b200',
      latestVersion: 'b200',
      running: false,
      ownership: 'stopped'
    })
    expect(apiHits).toBe(1) // cache de 30 min
  })

  it('recusa instalar com o llama-server gerenciado rodando', async () => {
    const sup = new FakeSupervisor()
    sup.pid = 1
    await expect(manager(sup).install('cuda-12.4')).rejects.toThrow(/STOP_FIRST/)
  })

  it('backend sem release → erro claro', async () => {
    await expect(manager().install('vulkan')).rejects.toThrow(/vulkan/)
  })
})

describe('start/stop', () => {
  function installed(): string {
    const d = join(dir, 'llama', 'b1-cpu')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'llama-server.exe'), 'x')
    writeFileSync(
      join(dir, 'llama', 'current.json'),
      JSON.stringify({ tag: 'b1', backend: 'cpu', dir: d })
    )
    return d
  }

  function mgr(sup: FakeSupervisor, health: () => boolean): LlamaManager {
    return new LlamaManager({
      userData: dir,
      supervisor: sup,
      startDownload: async () => undefined,
      emitLog: () => undefined,
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as typeof fetch,
      health: async () => health(),
      modelExists: () => true,
      pollMs: 1,
      healthTimeoutMs: 1000
    })
  }

  it('inicia pelo supervisor e espera /health', async () => {
    const d = installed()
    const sup = new FakeSupervisor()
    let calls = 0
    const m = mgr(sup, () => sup.pid !== null && ++calls > 3)
    await m.profiles.save(profile({ id: 'p1', port: 8111 }))

    const s = await m.start('p1')
    expect(sup.started).toHaveLength(1)
    expect(sup.started[0]).toMatchObject({
      id: 'llama',
      command: join(d, 'llama-server.exe'),
      cwd: d,
      healthUrl: 'http://127.0.0.1:8111/health'
    })
    expect(sup.started[0].args).toContain('8111')
    expect(s).toMatchObject({
      running: true,
      healthy: true,
      ownership: 'managed',
      pid: 4242,
      url: 'http://127.0.0.1:8111',
      latestVersion: null
    })

    const stopped = await m.stop()
    expect(sup.stopped).toBe(1)
    expect(stopped).toMatchObject({ running: false, ownership: 'stopped', pid: null })
  })

  it('processo que morre no carregamento → status com mensagem', async () => {
    installed()
    const sup = new FakeSupervisor()
    const m = mgr(sup, () => false)
    await m.profiles.save(profile({ id: 'p1' }))
    const origStart = sup.start.bind(sup)
    sup.start = async (spec) => {
      const pid = await origStart(spec)
      sup.pid = null // morreu logo
      return pid
    }
    const s = await m.start('p1')
    expect(s.message).toMatch(/encerrou/)
    expect(s.running).toBe(false)
  })

  it('não instalado ou perfil inválido → erro', async () => {
    const sup = new FakeSupervisor()
    await expect(mgr(sup, () => false).start()).rejects.toThrow(/não está instalado/)
    installed()
    // perfil padrão sem modelo
    await expect(mgr(sup, () => false).start()).rejects.toThrow(/\.gguf/)
    expect(sup.started).toHaveLength(0)
  })

  it('registerLlama liga handlers, status provider e start/stop', async () => {
    const sup = new FakeSupervisor()
    const ctx = createComponentsContext({
      userData: dir,
      emitStatus: () => undefined,
      emitLog: () => undefined,
      emitProgress: () => undefined,
      supervisor: sup as unknown as ProcessSupervisor
    })
    const handlers: ComponentHandlers = {}
    registerLlama(ctx, handlers, { health: async () => false })
    for (const k of [
      'llama.releases',
      'llama.install',
      'llama.profiles',
      'llama.saveProfile',
      'llama.deleteProfile'
    ]) {
      expect(typeof handlers[k]).toBe('function')
    }
    expect(ctx.statusProviders.has('llama')).toBe(true)
    expect(ctx.starters.has('llama')).toBe(true)
    expect(ctx.stoppers.has('llama')).toBe(true)
    expect(await handlers['llama.profiles']()).toEqual([defaultProfile()])
  })
})
