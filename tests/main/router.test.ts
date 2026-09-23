import { describe, it, expect, vi } from 'vitest'
import {
  RouterManager,
  RouterError,
  findListeningPid,
  parseNpmLs,
  parseNpmView,
  registerRouter,
  ROUTER_PORT,
  START_ARGS,
  LATEST_TTL_MS,
  type ExecResult
} from '../../src/main/components/router'
import { createComponentsContext, registerCore } from '../../src/main/components/context'
import type { ProcessSupervisor, SpawnSpec } from '../../src/main/components/supervisor'
import type { ComponentHandlers } from '../../src/main/components/ipc'
import type { ComponentStatus } from '../../src/shared/components'

// Nada aqui executa npm, 9router, netstat ou taskkill reais: tudo injetado.

const NPM_LS_OK = JSON.stringify({
  name: 'npm',
  dependencies: { '9router': { version: '0.5.55', overridden: false } }
})
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:56259        127.0.0.1:20128        TIME_WAIT       0',
  '  TCP    127.0.0.1:20128        127.0.0.1:56260        ESTABLISHED     777',
  '  TCP    0.0.0.0:20128          0.0.0.0:0              LISTENING       15588',
  '  UDP    0.0.0.0:20128          *:*                                    999'
].join('\r\n')

class FakeSupervisor {
  pid: number | null = null
  starts: SpawnSpec[] = []
  stops = 0
  managedPid(): number | null {
    return this.pid
  }
  async start(spec: SpawnSpec): Promise<number> {
    this.starts.push(spec)
    this.pid = 4242
    return 4242
  }
  async stop(): Promise<void> {
    this.stops++
    this.pid = null
  }
}

interface Setup {
  healthy?: boolean
  lsOut?: string
  whereCode?: number
  viewOut?: string
  viewCode?: number
  runCode?: number
}

interface Harness {
  mgr: RouterManager
  sup: FakeSupervisor
  state: { healthy: boolean; t: number }
  calls: string[]
  logs: string[]
  runs: string[]
  killed: number[]
}

function setup(o: Setup = {}): Harness {
  const sup = new FakeSupervisor()
  const state = { healthy: o.healthy ?? false, t: 0 }
  const calls: string[] = []
  const logs: string[] = []
  const exec = vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (line.includes('npm ls -g 9router'))
      return { code: o.lsOut ? 0 : 1, stdout: o.lsOut ?? '{}' }
    if (line.includes('npm view 9router version'))
      return { code: o.viewCode ?? 0, stdout: o.viewOut ?? '0.5.86\n' }
    if (cmd === 'where')
      return { code: o.whereCode ?? 1, stdout: o.whereCode === 0 ? 'C:\\x\\9router.cmd\r\n' : '' }
    if (cmd === 'netstat') return { code: 0, stdout: NETSTAT }
    throw new Error('comando inesperado: ' + line)
  })
  const runs: string[] = []
  const run = vi.fn(async (cmd: string, args: string[], onLine: (l: string) => void) => {
    runs.push([cmd, ...args].join(' '))
    onLine('added 1 package')
    return o.runCode ?? 0
  })
  const killed: number[] = []
  const mgr = new RouterManager({
    supervisor: sup as unknown as Pick<ProcessSupervisor, 'start' | 'stop' | 'managedPid'>,
    onLog: (l) => logs.push(l),
    exec,
    run,
    health: async () => state.healthy,
    killTree: async (pid) => {
      killed.push(pid)
      state.healthy = false
    },
    now: () => state.t,
    sleep: async (ms) => {
      state.t += ms
    },
    startTimeoutMs: 30_000,
    stopTimeoutMs: 5_000,
    pollMs: 500
  })
  return { mgr, sup, state, calls, logs, runs, killed }
}

describe('parsers', () => {
  it('parseNpmLs', () => {
    expect(parseNpmLs(NPM_LS_OK)).toBe('0.5.55')
    expect(parseNpmLs('{}')).toBeNull()
    expect(parseNpmLs('{"name":"npm"}')).toBeNull()
    expect(parseNpmLs('lixo')).toBeNull()
  })
  it('parseNpmView', () => {
    expect(parseNpmView('0.5.86\n')).toBe('0.5.86')
    expect(parseNpmView('\r\n1.2.3-beta.1\r\n')).toBe('1.2.3-beta.1')
    expect(parseNpmView('npm ERR! 404')).toBeNull()
    expect(parseNpmView('')).toBeNull()
  })
  it('findListeningPid ignora TIME_WAIT/ESTABLISHED/UDP e independe do idioma', () => {
    expect(findListeningPid(NETSTAT, ROUTER_PORT)).toBe(15588)
    expect(findListeningPid(NETSTAT, 8080)).toBeNull()
    const pt = '  TCP    [::]:20128             [::]:0                 ESCUTANDO       321'
    expect(findListeningPid(pt, ROUTER_PORT)).toBe(321)
    expect(
      findListeningPid('  TCP    0.0.0.0:120128    0.0.0.0:0   LISTENING  55', ROUTER_PORT)
    ).toBeNull()
    expect(
      findListeningPid('  TCP    0.0.0.0:20128   0.0.0.0:0   LISTENING  4', ROUTER_PORT)
    ).toBeNull()
  })
})

describe('status', () => {
  it('parado e não instalado', async () => {
    const { mgr } = setup()
    const s = await mgr.status()
    expect(s).toMatchObject({
      id: '9router',
      installed: false,
      version: null,
      latestVersion: '0.5.86',
      running: false,
      ownership: 'stopped',
      pid: null,
      healthy: false
    })
    expect(s.message).toMatch(/não está instalado/)
  })

  it('instalado via npm ls; externo saudável', async () => {
    const { mgr } = setup({ lsOut: NPM_LS_OK, healthy: true })
    const s = await mgr.status()
    expect(s).toMatchObject({
      installed: true,
      version: '0.5.55',
      running: true,
      ownership: 'external',
      healthy: true,
      pid: null,
      url: 'http://localhost:20128',
      message: null
    })
  })

  it('fallback where 9router quando npm ls falha', async () => {
    const { mgr, calls } = setup({ whereCode: 0 })
    const s = await mgr.status()
    expect(s.installed).toBe(true)
    expect(s.version).toBeNull()
    expect(calls).toContain('where 9router')
  })

  it('gerenciado: PID do supervisor', async () => {
    const { mgr, sup } = setup({ lsOut: NPM_LS_OK, healthy: true })
    sup.pid = 99
    const s = await mgr.status()
    expect(s).toMatchObject({ ownership: 'managed', pid: 99, running: true })
  })

  it('latestVersion: cache de 1 h e falha → null', async () => {
    const t = setup({ viewOut: 'x', viewCode: 1 })
    expect(await t.mgr.latestVersion()).toBeNull()
    const ok = setup()
    await ok.mgr.latestVersion()
    await ok.mgr.latestVersion()
    const views = (): number => ok.calls.filter((c) => c.includes('npm view')).length
    expect(views()).toBe(1)
    ok.state.t += LATEST_TTL_MS
    await ok.mgr.latestVersion()
    expect(views()).toBe(2)
  })

  it('npm sempre via cmd.exe /d /s /c', async () => {
    const { mgr, calls } = setup({ lsOut: NPM_LS_OK })
    await mgr.status()
    for (const c of calls.filter((x) => x.includes('npm')))
      expect(c.startsWith('cmd.exe /d /s /c npm ')).toBe(true)
  })
})

describe('start', () => {
  it('inicia via supervisor e espera ficar saudável', async () => {
    const { mgr, sup, state } = setup({ lsOut: NPM_LS_OK })
    let polls = 0
    const health = vi.fn(async () => {
      polls++
      return polls > 3 // 1ª chamada é a checagem "externo?"; saudável na 4ª
    })
    ;(mgr as unknown as { d: { health: typeof health } }).d.health = health
    const s = await mgr.start()
    expect(sup.starts).toHaveLength(1)
    expect(sup.starts[0]).toMatchObject({
      id: '9router',
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', ...START_ARGS],
      healthUrl: 'http://127.0.0.1:20128/v1/models'
    })
    expect(START_ARGS).toEqual([
      '9router',
      '--no-browser',
      '--log',
      '--skip-update',
      '-H',
      '127.0.0.1',
      '-p',
      '20128'
    ])
    expect(s.ownership).toBe('managed')
    expect(s.healthy).toBe(true)
    expect(state.t).toBeGreaterThan(0)
  })

  it('timeout de 30 s → status com message', async () => {
    const { mgr, state } = setup({ lsOut: NPM_LS_OK })
    const s = await mgr.start()
    expect(state.t).toBeGreaterThanOrEqual(30_000)
    expect(s.message).toMatch(/não respondeu em 30 s/)
    expect(s.ownership).toBe('managed')
  })

  it('processo morreu durante a espera', async () => {
    const { mgr, sup } = setup({ lsOut: NPM_LS_OK })
    const orig = sup.start.bind(sup)
    sup.start = async (spec) => {
      const pid = await orig(spec)
      sup.pid = null
      return pid
    }
    const s = await mgr.start()
    expect(s.message).toMatch(/encerrou/)
  })

  it('não instalado → NOT_INSTALLED; externo rodando → não inicia outro', async () => {
    const a = setup()
    await expect(a.mgr.start()).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
    const b = setup({ lsOut: NPM_LS_OK, healthy: true })
    const s = await b.mgr.start()
    expect(b.sup.starts).toHaveLength(0)
    expect(s.ownership).toBe('external')
  })
})

describe('stop', () => {
  it('gerenciado → supervisor.stop', async () => {
    const { mgr, sup, killed } = setup({ lsOut: NPM_LS_OK })
    sup.pid = 50
    const s = await mgr.stop()
    expect(sup.stops).toBe(1)
    expect(killed).toEqual([])
    expect(s.ownership).toBe('stopped')
  })

  it('externo sem force → NEEDS_FORCE, nada é morto', async () => {
    const { mgr, killed, calls } = setup({ lsOut: NPM_LS_OK, healthy: true })
    const err = await mgr.stop().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RouterError)
    expect((err as RouterError).code).toBe('NEEDS_FORCE')
    expect(killed).toEqual([])
    expect(calls.some((c) => c.startsWith('netstat'))).toBe(false)
  })

  it('externo com force → PID pela porta + killTree', async () => {
    const { mgr, killed, calls } = setup({ lsOut: NPM_LS_OK, healthy: true })
    const s = await mgr.stop({ force: true })
    expect(calls).toContain('netstat -ano')
    expect(killed).toEqual([15588])
    expect(s.ownership).toBe('stopped')
  })

  it('parado → só devolve status', async () => {
    const { mgr, killed, sup } = setup({ lsOut: NPM_LS_OK })
    const s = await mgr.stop({ force: true })
    expect(killed).toEqual([])
    expect(sup.stops).toBe(0)
    expect(s.running).toBe(false)
  })
})

describe('install/update', () => {
  it('parado: roda npm i -g 9router@latest via cmd.exe com saída no log', async () => {
    const { mgr, runs, logs, sup } = setup()
    await mgr.install()
    expect(runs).toEqual(['cmd.exe /d /s /c npm i -g 9router@latest'])
    expect(logs).toContain('added 1 package')
    expect(sup.starts).toHaveLength(0)
  })

  it('externo rodando → STOP_FIRST sem rodar npm', async () => {
    const { mgr, runs } = setup({ lsOut: NPM_LS_OK, healthy: true })
    await expect(mgr.update()).rejects.toMatchObject({ code: 'STOP_FIRST' })
    expect(runs).toEqual([])
  })

  it('gerenciado rodando → para, atualiza e reinicia', async () => {
    const { mgr, sup, runs, state } = setup({ lsOut: NPM_LS_OK })
    sup.pid = 77
    const order: string[] = []
    const origStop = sup.stop.bind(sup)
    sup.stop = async () => {
      order.push('stop')
      await origStop()
    }
    ;(mgr as unknown as { d: { run: (...a: unknown[]) => Promise<number> } }).d.run = async () => {
      order.push('npm')
      runs.push('npm')
      state.healthy = false
      return 0
    }
    const origStart = sup.start.bind(sup)
    sup.start = async (spec) => {
      order.push('start')
      const pid = await origStart(spec)
      state.healthy = true
      return pid
    }
    await mgr.update()
    expect(order).toEqual(['stop', 'npm', 'start'])
  })

  it('npm falha → INSTALL_FAILED (e ainda reinicia o gerenciado)', async () => {
    const { mgr, sup } = setup({ lsOut: NPM_LS_OK, runCode: 1 })
    sup.pid = 77
    await expect(mgr.update()).rejects.toMatchObject({ code: 'INSTALL_FAILED' })
    expect(sup.starts).toHaveLength(1)
  })

  it('concorrente → BUSY', async () => {
    const { mgr } = setup()
    let release!: () => void
    ;(mgr as unknown as { d: { run: () => Promise<number> } }).d.run = () =>
      new Promise<number>((r) => (release = () => r(0)))
    const first = mgr.install()
    await Promise.resolve()
    await Promise.resolve()
    await expect(mgr.install()).rejects.toMatchObject({ code: 'BUSY' })
    await new Promise((r) => setTimeout(r, 0))
    release()
    await first
  })
})

describe('registerRouter + roteamento genérico', () => {
  function makeCtx(): {
    ctx: ReturnType<typeof createComponentsContext>
    sup: FakeSupervisor
    statuses: ComponentStatus[]
  } {
    const sup = new FakeSupervisor()
    const statuses: ComponentStatus[] = []
    const ctx = createComponentsContext({
      userData: 'X:/nao-usado',
      emitStatus: (s) => statuses.push(s),
      emitLog: () => undefined,
      emitProgress: () => undefined,
      supervisor: sup as unknown as ProcessSupervisor
    })
    return { ctx, sup, statuses }
  }

  it('status agrega todos os providers; start/stop roteiam por id', async () => {
    const { ctx, sup, statuses } = makeCtx()
    const handlers: ComponentHandlers = {}
    registerCore(ctx, handlers)
    let healthy = false
    registerRouter(ctx, handlers, {
      exec: async (cmd, args) => {
        const l = [cmd, ...args].join(' ')
        if (l.includes('npm ls')) return { code: 0, stdout: NPM_LS_OK }
        if (l.includes('npm view')) return { code: 0, stdout: '0.5.86' }
        throw new Error('inesperado ' + l)
      },
      run: async () => 0,
      health: async () => healthy,
      sleep: async () => {
        healthy = true
      }
    })
    const fakeLlama: ComponentStatus = {
      id: 'llama',
      installed: false,
      version: null,
      latestVersion: null,
      running: false,
      ownership: 'stopped',
      pid: null,
      url: null,
      healthy: false,
      message: null
    }
    ctx.statusProviders.set('llama', async () => fakeLlama)

    const all = (await handlers['status']()) as ComponentStatus[]
    expect(all.map((s) => s.id).sort()).toEqual(['9router', 'llama'])

    const started = (await handlers['start']('9router')) as ComponentStatus
    expect(sup.starts).toHaveLength(1)
    expect(started.ownership).toBe('managed')

    await expect(async () => handlers['start']('llama')).rejects.toThrow(/não implementado/)

    const origStop = sup.stop.bind(sup)
    sup.stop = async () => {
      await origStop()
      healthy = false
    }
    const stopped = (await handlers['stop']('9router', {})) as ComponentStatus
    expect(stopped.ownership).toBe('stopped')

    await handlers['router.install']()
    expect(statuses.some((s) => s.id === '9router')).toBe(true)
  })

  it('status: provider que falha não derruba os outros', async () => {
    const { ctx } = makeCtx()
    const handlers: ComponentHandlers = {}
    registerCore(ctx, handlers)
    ctx.statusProviders.set('llama', async () => {
      throw new Error('boom')
    })
    expect(await handlers['status']()).toEqual([])
  })
})
