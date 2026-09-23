import { execFile, spawn } from 'node:child_process'
import type { ComponentStatus } from '../../shared/components'
import type { ComponentHandlers } from './ipc'
import type { ComponentsContext } from './context'
import { checkHealth, killTree, type ProcessSupervisor, type SpawnSpec } from './supervisor'

export const ROUTER_PORT = 20128
/** URL mostrada na UI. */
export const ROUTER_URL = `http://localhost:${ROUTER_PORT}`
/** Health em IPv4 explícito: funciona com `-H 127.0.0.1` (gerenciado) e com `0.0.0.0` (externo). */
export const ROUTER_HEALTH_URL = `http://127.0.0.1:${ROUTER_PORT}/v1/models`
export const LATEST_TTL_MS = 60 * 60 * 1000
/** Falha do `npm view` fica em cache por menos tempo (offline não trava todo status). */
export const LATEST_FAIL_TTL_MS = 5 * 60 * 1000

/** npm e 9router são `.cmd` no Windows: sempre via `cmd.exe /d /s /c`. */
const CMD = 'cmd.exe'
const CMD_PREFIX = ['/d', '/s', '/c']
export const START_ARGS = [
  '9router',
  '--no-browser',
  '--log',
  '--skip-update',
  '-H',
  '127.0.0.1',
  '-p',
  String(ROUTER_PORT)
]

export type RouterErrorCode =
  'STOP_FIRST' | 'NOT_INSTALLED' | 'NEEDS_FORCE' | 'PID_NOT_FOUND' | 'INSTALL_FAILED' | 'BUSY'

export class RouterError extends Error {
  constructor(
    readonly code: RouterErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RouterError'
  }
}

/** Resultado de um comando curto. Nunca rejeita por código de saída != 0. */
export interface ExecResult {
  code: number
  stdout: string
}
export type RouterExec = (cmd: string, args: string[]) => Promise<ExecResult>
/** Comando longo com saída linha a linha; resolve com o código de saída. */
export type RouterRun = (
  cmd: string,
  args: string[],
  onLine: (l: string) => void
) => Promise<number>

export interface RouterDeps {
  supervisor: Pick<ProcessSupervisor, 'start' | 'stop' | 'managedPid'>
  onLog(line: string): void
  exec: RouterExec
  run: RouterRun
  health(url: string): Promise<boolean>
  killTree(pid: number): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
  startTimeoutMs: number
  stopTimeoutMs: number
  pollMs: number
}

const defaultExec: RouterExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: String(stdout ?? '') })
      }
    )
  })

const defaultRun: RouterRun = (cmd, args, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const attach = (s: NodeJS.ReadableStream | null): void => {
      if (!s) return
      let rest = ''
      s.setEncoding('utf8')
      s.on('data', (chunk: string) => {
        const parts = (rest + chunk).split(/\r?\n/)
        rest = parts.pop() ?? ''
        for (const p of parts) if (p) onLine(p)
      })
      s.on('end', () => {
        if (rest) onLine(rest)
      })
    }
    attach(child.stdout)
    attach(child.stderr)
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? -1))
  })

/** Versão do 9router em `npm ls -g 9router --json --depth=0` (ausente/JSON inválido → null). */
export function parseNpmLs(out: string): string | null {
  try {
    const j = JSON.parse(out) as { dependencies?: Record<string, { version?: unknown }> }
    const v = j.dependencies?.['9router']?.version
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/** Saída de `npm view 9router version` → versão semver, senão null. */
export function parseNpmView(out: string): string | null {
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l)
  return line && /^\d+\.\d+\.\d+\S*$/.test(line) ? line : null
}

/**
 * PID que escuta em `port` na saída de `netstat -ano`. Independe do idioma do Windows
 * (a coluna de estado é traduzida): "escutando" = TCP com endereço remoto `0.0.0.0:0`/`[::]:0`.
 */
export function findListeningPid(netstat: string, port: number): number | null {
  for (const raw of netstat.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    const local = cols[1]
    const remote = cols[2]
    if (!local.endsWith(`:${port}`)) continue
    if (remote !== '0.0.0.0:0' && remote !== '[::]:0' && remote !== '*:*') continue
    const pid = Number(cols[cols.length - 1])
    // 0 = System Idle, 4 = System: nunca.
    if (Number.isInteger(pid) && pid > 4) return pid
  }
  return null
}

/**
 * Gerencia o 9router (pacote npm global). Processo iniciado pelo app = gerenciado (supervisor);
 * já rodando antes = externo (só para com `force`, PID achado pela porta).
 */
export class RouterManager {
  private readonly d: RouterDeps
  private latest: { value: string | null; at: number } | null = null
  private busy = false

  constructor(deps: Partial<RouterDeps> & Pick<RouterDeps, 'supervisor' | 'onLog'>) {
    this.d = {
      exec: defaultExec,
      run: defaultRun,
      health: (url) => checkHealth(url),
      killTree,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      startTimeoutMs: 30_000,
      stopTimeoutMs: 5_000,
      pollMs: 500,
      ...deps
    }
  }

  private npm(args: string[]): Promise<ExecResult> {
    return this.d.exec(CMD, [...CMD_PREFIX, 'npm', ...args])
  }

  /** Versão instalada (`npm ls -g`); fallback `where 9router` → instalado sem versão conhecida. */
  async installed(): Promise<{ installed: boolean; version: string | null }> {
    try {
      const ls = await this.npm(['ls', '-g', '9router', '--json', '--depth=0'])
      const version = parseNpmLs(ls.stdout)
      if (version) return { installed: true, version }
    } catch {
      /* cai no fallback */
    }
    try {
      const w = await this.d.exec('where', ['9router'])
      return { installed: w.code === 0 && w.stdout.trim() !== '', version: null }
    } catch {
      return { installed: false, version: null }
    }
  }

  /** `npm view 9router version` com cache de 1 h (falha → null, cache de 5 min). */
  async latestVersion(): Promise<string | null> {
    const now = this.d.now()
    if (this.latest) {
      const ttl = this.latest.value === null ? LATEST_FAIL_TTL_MS : LATEST_TTL_MS
      if (now - this.latest.at < ttl) return this.latest.value
    }
    let value: string | null = null
    try {
      const r = await this.npm(['view', '9router', 'version'])
      value = r.code === 0 ? parseNpmView(r.stdout) : null
    } catch {
      value = null
    }
    this.latest = { value, at: now }
    return value
  }

  async status(message: string | null = null): Promise<ComponentStatus> {
    const [inst, latestVersion, healthy] = await Promise.all([
      this.installed(),
      this.latestVersion(),
      this.d.health(ROUTER_HEALTH_URL)
    ])
    const pid = this.d.supervisor.managedPid('9router')
    const ownership = pid !== null ? 'managed' : healthy ? 'external' : 'stopped'
    let msg = message
    if (!msg && !inst.installed && !healthy) msg = '9router não está instalado'
    if (!msg && pid !== null && !healthy) msg = '9router iniciado, mas ainda sem resposta'
    return {
      id: '9router',
      installed: inst.installed || healthy,
      version: inst.version,
      latestVersion,
      running: pid !== null || healthy,
      ownership,
      pid,
      url: ROUTER_URL,
      healthy,
      message: msg
    }
  }

  async start(): Promise<ComponentStatus> {
    if (this.d.supervisor.managedPid('9router') !== null) {
      return this.status('9router já está rodando (iniciado pelo app)')
    }
    if (await this.d.health(ROUTER_HEALTH_URL)) {
      return this.status('9router já está rodando fora do app')
    }
    const inst = await this.installed()
    if (!inst.installed) {
      throw new RouterError(
        'NOT_INSTALLED',
        '9router não está instalado. Instale antes de iniciar.'
      )
    }
    const spec: SpawnSpec = {
      id: '9router',
      command: CMD,
      args: [...CMD_PREFIX, ...START_ARGS],
      healthUrl: ROUTER_HEALTH_URL
    }
    await this.d.supervisor.start(spec)
    const deadline = this.d.now() + this.d.startTimeoutMs
    for (;;) {
      if (await this.d.health(ROUTER_HEALTH_URL)) return this.status()
      if (this.d.supervisor.managedPid('9router') === null) {
        return this.status('9router encerrou logo após iniciar (veja os logs)')
      }
      if (this.d.now() >= deadline) {
        return this.status(
          `9router não respondeu em ${Math.round(this.d.startTimeoutMs / 1000)} s (veja os logs)`
        )
      }
      await this.d.sleep(this.d.pollMs)
    }
  }

  async stop(opts: { force?: boolean } = {}): Promise<ComponentStatus> {
    if (this.d.supervisor.managedPid('9router') !== null) {
      await this.d.supervisor.stop('9router')
      return this.status()
    }
    if (!(await this.d.health(ROUTER_HEALTH_URL))) return this.status()
    if (!opts.force) {
      throw new RouterError(
        'NEEDS_FORCE',
        'O 9router está rodando fora do app. Confirme para encerrá-lo mesmo assim.'
      )
    }
    const ns = await this.d.exec('netstat', ['-ano'])
    const pid = findListeningPid(ns.stdout, ROUTER_PORT)
    if (pid === null) {
      throw new RouterError(
        'PID_NOT_FOUND',
        `Não foi possível achar o processo escutando na porta ${ROUTER_PORT}.`
      )
    }
    this.d.onLog(`[encerrando 9router externo (PID ${pid})]`)
    await this.d.killTree(pid)
    const deadline = this.d.now() + this.d.stopTimeoutMs
    while (await this.d.health(ROUTER_HEALTH_URL)) {
      if (this.d.now() >= deadline) return this.status('9router ainda responde após encerrar')
      await this.d.sleep(this.d.pollMs)
    }
    return this.status()
  }

  install(): Promise<void> {
    return this.npmInstall('instalação')
  }

  update(): Promise<void> {
    return this.npmInstall('atualização')
  }

  /**
   * `npm i -g 9router@latest`. Gerenciado rodando → para antes e reinicia depois (mesmo se falhar);
   * externo rodando → `STOP_FIRST` (o npm não consegue substituir arquivos em uso).
   */
  private async npmInstall(label: string): Promise<void> {
    if (this.busy)
      throw new RouterError('BUSY', 'Já existe uma instalação do 9router em andamento.')
    this.busy = true
    try {
      const wasManaged = this.d.supervisor.managedPid('9router') !== null
      if (!wasManaged && (await this.d.health(ROUTER_HEALTH_URL))) {
        throw new RouterError(
          'STOP_FIRST',
          `O 9router está rodando fora do app. Pare-o antes da ${label}.`
        )
      }
      if (wasManaged) await this.d.supervisor.stop('9router')
      let failure: unknown = null
      try {
        this.d.onLog(`[${label}: npm i -g 9router@latest]`)
        const code = await this.d.run(
          CMD,
          [...CMD_PREFIX, 'npm', 'i', '-g', '9router@latest'],
          (l) => this.d.onLog(l)
        )
        if (code !== 0) {
          throw new RouterError('INSTALL_FAILED', `npm terminou com código ${code} (veja os logs).`)
        }
        this.latest = null
      } catch (e) {
        failure = e
      }
      if (wasManaged) {
        try {
          await this.start()
        } catch (e) {
          if (!failure) failure = e
          else this.d.onLog(`[falha ao reiniciar: ${e instanceof Error ? e.message : String(e)}]`)
        }
      }
      if (failure) throw failure
    } finally {
      this.busy = false
    }
  }
}

/**
 * Task 4.2: `router.install`, `router.update` e as entradas `'9router'` de
 * `statusProviders`/`starters`/`stoppers` (roteadas pelos genéricos `status`/`start`/`stop`).
 */
export function registerRouter(
  ctx: ComponentsContext,
  handlers: ComponentHandlers,
  deps: Partial<Omit<RouterDeps, 'supervisor' | 'onLog'>> = {}
): RouterManager {
  const mgr = new RouterManager({
    ...deps,
    supervisor: ctx.supervisor,
    onLog: (line) => ctx.emitLog({ id: '9router', line })
  })
  ctx.statusProviders.set('9router', () => mgr.status())
  ctx.starters.set('9router', () => mgr.start())
  ctx.stoppers.set('9router', (opts) => mgr.stop(opts))
  const after = async (p: Promise<void>): Promise<void> => {
    try {
      await p
    } finally {
      await ctx.refreshStatus('9router')
    }
  }
  handlers['router.install'] = () => after(mgr.install())
  handlers['router.update'] = () => after(mgr.update())
  return mgr
}
