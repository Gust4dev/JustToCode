import { spawn, execFile, type ChildProcess } from 'node:child_process'
import type { ComponentId } from '../../shared/components'
import { clearPid, readPids, setPid } from './pids'

export interface SpawnSpec {
  id: ComponentId
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  healthUrl: string
}

export interface SupervisorDeps {
  pidsFile: string
  onStatus(id: ComponentId, running: boolean, pid: number | null): void
  onLog(id: ComponentId, line: string): void
  spawnImpl?: typeof spawn
  killTreeImpl?: (pid: number) => Promise<void>
  isAliveImpl?: (pid: number) => boolean
}

export const LOG_LIMIT = 2000
const EXIT_WAIT_MS = 5000

export class SupervisorError extends Error {
  constructor(
    readonly code: 'ALREADY_RUNNING' | 'SPAWN_FAILED',
    message: string
  ) {
    super(message)
    this.name = 'SupervisorError'
  }
}

/** `taskkill /PID <pid> /T /F` (Windows). Nunca mata por nome. */
export function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* já morreu */
    }
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    // Código != 0 quando o processo já não existe: tratado como sucesso (o efeito desejado é o mesmo).
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** GET com timeout; 2xx = saudável. Qualquer erro → false. */
export async function checkHealth(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel().catch(() => undefined)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Inicia/para processos "gerenciados" (PID em `pids.json`). Só mata PIDs que ele mesmo registrou.
 */
export class ProcessSupervisor {
  private readonly spawnImpl: typeof spawn
  private readonly killTreeImpl: (pid: number) => Promise<void>
  private readonly isAliveImpl: (pid: number) => boolean
  private readonly children = new Map<ComponentId, ChildProcess>()
  private readonly exits = new Map<ComponentId, Promise<void>>()
  private readonly logBuf = new Map<ComponentId, string[]>()

  constructor(private readonly d: SupervisorDeps) {
    this.spawnImpl = d.spawnImpl ?? spawn
    this.killTreeImpl = d.killTreeImpl ?? killTree
    this.isAliveImpl = d.isAliveImpl ?? isAlive
  }

  /** PID gerenciado vivo (relê `pids.json`; adoção após crash do app). PID morto → limpa a entrada. */
  managedPid(id: ComponentId): number | null {
    const child = this.children.get(id)
    if (child?.pid && child.exitCode === null && child.signalCode === null) return child.pid
    const entry = readPids(this.d.pidsFile)[id]
    if (!entry) return null
    if (this.isAliveImpl(entry.pid)) return entry.pid
    clearPid(this.d.pidsFile, id, entry.pid)
    return null
  }

  async start(spec: SpawnSpec): Promise<number> {
    const { id } = spec
    const cur = this.managedPid(id)
    if (cur !== null) {
      throw new SupervisorError('ALREADY_RUNNING', `${id} já está rodando (PID ${cur})`)
    }
    const child = this.spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const pid = await new Promise<number>((resolve, reject) => {
      child.once('spawn', () => {
        if (child.pid) resolve(child.pid)
        else reject(new SupervisorError('SPAWN_FAILED', `${id}: processo sem PID`))
      })
      child.once('error', (e) =>
        reject(new SupervisorError('SPAWN_FAILED', `${id}: falha ao iniciar (${e.message})`))
      )
    })

    this.children.set(id, child)
    setPid(this.d.pidsFile, id, pid)
    this.attachLines(id, child.stdout)
    this.attachLines(id, child.stderr)
    this.exits.set(
      id,
      new Promise<void>((resolve) => {
        child.once('exit', (code, signal) => {
          if (this.children.get(id) === child) this.children.delete(id)
          clearPid(this.d.pidsFile, id, pid)
          this.pushLog(id, `[processo encerrou: ${signal ?? `código ${code}`}]`)
          this.d.onStatus(id, false, null)
          resolve()
        })
      })
    )
    this.d.onStatus(id, true, pid)
    return pid
  }

  async stop(id: ComponentId): Promise<void> {
    const pid = this.managedPid(id)
    if (pid === null) return
    const exited = this.children.get(id)?.pid === pid ? this.exits.get(id) : undefined
    await this.killTreeImpl(pid)
    if (exited) {
      await Promise.race([exited, new Promise((r) => setTimeout(r, EXIT_WAIT_MS))])
    } else {
      // Processo adotado (não é filho deste app): não há evento de saída.
      clearPid(this.d.pidsFile, id, pid)
      this.d.onStatus(id, false, null)
    }
  }

  logs(id: ComponentId): string[] {
    return [...(this.logBuf.get(id) ?? [])]
  }

  /** Para só os gerenciados (before-quit). */
  async stopAll(): Promise<void> {
    const ids = new Set<ComponentId>([
      ...this.children.keys(),
      ...(Object.keys(readPids(this.d.pidsFile)) as ComponentId[])
    ])
    await Promise.all([...ids].map((id) => this.stop(id).catch(() => undefined)))
  }

  private pushLog(id: ComponentId, line: string): void {
    let buf = this.logBuf.get(id)
    if (!buf) this.logBuf.set(id, (buf = []))
    buf.push(line)
    if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT)
    this.d.onLog(id, line)
  }

  private attachLines(id: ComponentId, stream: NodeJS.ReadableStream | null): void {
    if (!stream) return
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const parts = (rest + chunk).split(/\r?\n/)
      rest = parts.pop() ?? ''
      for (const p of parts) this.pushLog(id, p)
    })
    stream.on('end', () => {
      if (rest) this.pushLog(id, rest)
      rest = ''
    })
  }
}
