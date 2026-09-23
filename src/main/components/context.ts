import { join } from 'node:path'
import type { ComponentId, ComponentStatus, DownloadProgress } from '../../shared/components'
import type { ComponentHandlers } from './ipc'
import { ProcessSupervisor } from './supervisor'
import { download, type DownloadParams } from './downloader'
import { detectHardware, type ExecFn } from './hardware'

/**
 * Estado compartilhado pelos módulos de componentes (criado uma vez em `initComponents`).
 * Cada módulo expõe `registerXxx(ctx, handlers)` e preenche os métodos IPC dele.
 */
export interface ComponentsContext {
  /** Supervisor único (pids em `userData/components/pids.json`). */
  supervisor: ProcessSupervisor
  emitStatus(s: ComponentStatus): void
  emitLog(e: { id: ComponentId; line: string }): void
  emitProgress(p: DownloadProgress): void
  userData: string
  /** Downloads em andamento por id (cancelados por `cancelDownload`). */
  downloads: Map<string, AbortController>
  /**
   * Status completo por componente, registrado pelas tasks 4.2/4.3. O supervisor chama isso
   * quando um processo gerenciado inicia/encerra e emite o resultado via `emitStatus`.
   */
  statusProviders: Map<ComponentId, () => Promise<ComponentStatus>>
  /**
   * Roteamento dos handlers genéricos `start(id, profileId?)` / `stop(id, { force })` (ver
   * `registerCore`). Cada manager registra o seu: 4.2 → `'9router'`, 4.3 → `'llama'`
   * (`ctx.starters.set('llama', (profileId) => ...)`). Sem entrada → erro "não implementado".
   */
  starters: Map<ComponentId, (profileId?: string) => Promise<ComponentStatus>>
  stoppers: Map<ComponentId, (opts?: { force?: boolean }) => Promise<ComponentStatus>>
  /** Recalcula e emite o status de `id` (sem provider → nada). */
  refreshStatus(id: ComponentId): Promise<void>
  /** `download` com registro em `downloads` e progresso em `emitProgress`. Id duplicado → erro. */
  startDownload(p: Omit<DownloadParams, 'signal' | 'onProgress'>): Promise<void>
}

export interface ContextDeps {
  userData: string
  emitStatus(s: ComponentStatus): void
  emitLog(e: { id: ComponentId; line: string }): void
  emitProgress(p: DownloadProgress): void
  /** Para testes: supervisor pronto (senão cria o real). */
  supervisor?: ProcessSupervisor
}

export function createComponentsContext(d: ContextDeps): ComponentsContext {
  const statusProviders: ComponentsContext['statusProviders'] = new Map()
  const downloads = new Map<string, AbortController>()
  const starters: ComponentsContext['starters'] = new Map()
  const stoppers: ComponentsContext['stoppers'] = new Map()

  const refreshStatus = async (id: ComponentId): Promise<void> => {
    const provider = statusProviders.get(id)
    if (!provider) return
    try {
      d.emitStatus(await provider())
    } catch (e) {
      d.emitLog({ id, line: `[status falhou: ${e instanceof Error ? e.message : String(e)}]` })
    }
  }

  const supervisor =
    d.supervisor ??
    new ProcessSupervisor({
      pidsFile: join(d.userData, 'components', 'pids.json'),
      onStatus: (id) => void refreshStatus(id),
      onLog: (id, line) => d.emitLog({ id, line })
    })

  return {
    supervisor,
    emitStatus: d.emitStatus,
    emitLog: d.emitLog,
    emitProgress: d.emitProgress,
    userData: d.userData,
    downloads,
    statusProviders,
    starters,
    stoppers,
    refreshStatus,
    async startDownload(p) {
      if (downloads.has(p.id)) throw new Error(`download "${p.id}" já está em andamento`)
      const ctrl = new AbortController()
      downloads.set(p.id, ctrl)
      try {
        await download({ ...p, signal: ctrl.signal, onProgress: d.emitProgress })
      } finally {
        if (downloads.get(p.id) === ctrl) downloads.delete(p.id)
      }
    }
  }
}

/**
 * Handlers da task 4.1 (`hardware`, `cancelDownload`) + os genéricos por id, que só roteiam
 * para o que cada manager registrou no contexto: `status` (todos os `statusProviders`),
 * `logs` (ring buffer do supervisor), `start`/`stop` (`starters`/`stoppers`).
 */
export function registerCore(
  ctx: ComponentsContext,
  handlers: ComponentHandlers,
  exec?: ExecFn
): void {
  // Um provider que falha não derruba os outros (o erro vai para o log do componente).
  handlers['status'] = async () => {
    const entries = [...ctx.statusProviders.entries()]
    const res = await Promise.allSettled(entries.map(([, p]) => p()))
    const out: ComponentStatus[] = []
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(r.value)
      else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        ctx.emitLog({ id: entries[i][0], line: `[status falhou: ${msg}]` })
      }
    })
    return out
  }
  handlers['logs'] = (id: ComponentId) => ctx.supervisor.logs(id)
  handlers['start'] = (id: ComponentId, profileId?: string) => {
    const f = ctx.starters.get(id)
    if (!f) throw new Error(`components: start("${String(id)}") ainda não implementado`)
    return f(profileId)
  }
  handlers['stop'] = (id: ComponentId, opts?: { force?: boolean }) => {
    const f = ctx.stoppers.get(id)
    if (!f) throw new Error(`components: stop("${String(id)}") ainda não implementado`)
    return f(opts)
  }
  handlers['hardware'] = () => detectHardware(exec)
  handlers['cancelDownload'] = (id: string) => {
    ctx.downloads.get(id)?.abort()
  }
}
