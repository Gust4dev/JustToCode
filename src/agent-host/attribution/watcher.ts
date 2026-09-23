import { readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { subscribe } from '@parcel/watcher'
import type { HostContext } from '../context'
import type { FileChangeRepo } from '../repo/fileChanges'
import type { BlobStore } from '../blobs'
import { git } from './git'
import { indexContent, sha256, MAX_BLOB_BYTES } from './gitState'
import type { CommandWindowRegistry, RecentToolWrites } from './commandWindows'

export { CommandWindowRegistry, RecentToolWrites } from './commandWindows'

export interface ProjectWatcher {
  start(projectId: string, root: string): Promise<void>
  stop(projectId: string): Promise<void>
  stopAll(): Promise<void>
}

export interface WatcherDeps {
  ctx: HostContext
  repo: FileChangeRepo
  registry: CommandWindowRegistry
  toolWrites: RecentToolWrites
  blobs: BlobStore
  /** Debounce por caminho (padrão 500 ms). */
  debounceMs?: number
}

interface Subscription {
  unsubscribe(): Promise<void>
}

interface Watched {
  root: string
  sub: Subscription | null
  timers: Map<string, ReturnType<typeof setTimeout>>
  /** Instante do último evento por caminho relativo. */
  eventAt: Map<string, number>
  pending: Set<string>
  /** Cadeia de processamento: um lote por vez por projeto. */
  chain: Promise<void>
  stopped: boolean
}

const toPosix = (p: string): string => p.replace(/\\/g, '/')

/** `.git` e `node_modules` em qualquer nível ficam fora sem nem perguntar ao git. */
const HARD_IGNORED = /(^|\/)(\.git|node_modules)(\/|$)/

const realRoot = (root: string): string => {
  try {
    return realpathSync.native(resolve(root))
  } catch {
    return resolve(root)
  }
}

/** Caminhos (relativos) ignorados pelo git, consultados em lote. */
async function gitIgnored(root: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set()
  const r = await git(root, ['check-ignore', '--stdin', '-z'], { input: rels.join('\0') + '\0' })
  // 0 = algum ignorado, 1 = nenhum, 128 = erro (ex.: não é repo) → trata como nenhum.
  if (r.code !== 0) return new Set()
  return new Set(
    r.stdout
      .toString('utf8')
      .split('\0')
      .filter((p) => p.length > 0)
      .map(toPosix)
  )
}

/**
 * Watcher por projeto: mudanças fora de ferramenta/comando viram `origin: 'external'`.
 * Ignora `.git`, `node_modules` e o que o git ignora.
 */
export function createProjectWatcher(d: WatcherDeps): ProjectWatcher {
  const debounceMs = d.debounceMs ?? 500
  const watched = new Map<string, Watched>()

  const currentHash = async (abs: string): Promise<string | null | undefined> => {
    try {
      const st = await stat(abs)
      if (!st.isFile()) return undefined // pasta: nada a registrar
      const buf = await readFile(abs)
      return buf.length <= MAX_BLOB_BYTES ? d.blobs.put(buf) : sha256(buf)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  const processPath = async (projectId: string, w: Watched, rel: string): Promise<void> => {
    const t = w.eventAt.get(rel) ?? Date.now()
    // Comando em andamento (ou que cobria o evento): quem registra é o comando.
    if (
      d.registry.activeAt(projectId, t).length > 0 ||
      d.registry.activeAt(projectId, Date.now()).length > 0
    ) {
      return
    }
    const hash = await currentHash(resolve(w.root, rel))
    if (hash === undefined) return
    if (d.toolWrites.isRecent(projectId, rel, hash)) return

    let beforeHash: string | null
    const last = d.repo.lastForPath(projectId, rel)
    if (last) {
      beforeHash = last.afterHash
    } else {
      const buf = await indexContent(w.root, rel)
      beforeHash =
        buf === null ? null : buf.length <= MAX_BLOB_BYTES ? d.blobs.put(buf) : sha256(buf)
    }
    if (beforeHash === hash) return
    // Recheca: um comando pode ter aberto enquanto líamos.
    if (d.registry.activeAt(projectId, Date.now()).length > 0) return

    const c = d.repo.insert({
      projectId,
      chatId: null,
      candidateChatIds: [],
      origin: 'external',
      path: rel,
      beforeHash,
      afterHash: hash,
      toolCallId: null
    })
    d.ctx.emit({
      type: 'file_touched',
      projectId,
      chatId: null,
      path: c.path,
      origin: 'external'
    })
  }

  const flush = (projectId: string, w: Watched): void => {
    w.chain = w.chain
      .then(async () => {
        if (w.stopped || w.pending.size === 0) return
        const batch = [...w.pending].sort()
        w.pending.clear()
        const ignored = await gitIgnored(w.root, batch)
        for (const rel of batch) {
          if (w.stopped) return
          if (ignored.has(rel)) continue
          try {
            await processPath(projectId, w, rel)
          } catch (e) {
            console.warn(`[watcher] falha ao processar ${rel}:`, e)
          }
        }
      })
      .catch((e) => console.warn('[watcher] falha no lote:', e))
  }

  const onEvent = (projectId: string, w: Watched, absPath: string): void => {
    if (w.stopped) return
    const relRaw = relative(w.root, absPath)
    if (!relRaw || relRaw.startsWith('..') || isAbsolute(relRaw)) return
    const rel = toPosix(relRaw)
    if (HARD_IGNORED.test(rel)) return
    w.eventAt.set(rel, Date.now())
    const prev = w.timers.get(rel)
    if (prev) clearTimeout(prev)
    w.timers.set(
      rel,
      setTimeout(() => {
        w.timers.delete(rel)
        if (w.stopped) return
        w.pending.add(rel)
        flush(projectId, w)
      }, debounceMs)
    )
  }

  const stop = async (projectId: string): Promise<void> => {
    const w = watched.get(projectId)
    if (!w) return
    watched.delete(projectId)
    w.stopped = true
    for (const t of w.timers.values()) clearTimeout(t)
    w.timers.clear()
    await w.sub?.unsubscribe().catch(() => undefined)
    await w.chain
  }

  return {
    async start(projectId, root) {
      const abs = realRoot(root)
      const existing = watched.get(projectId)
      if (existing && existing.root === abs) return
      if (existing) await stop(projectId)
      const w: Watched = {
        root: abs,
        sub: null,
        timers: new Map(),
        eventAt: new Map(),
        pending: new Set(),
        chain: Promise.resolve(),
        stopped: false
      }
      watched.set(projectId, w)
      try {
        const sub = await subscribe(
          abs,
          (err, events) => {
            if (err) {
              console.warn('[watcher] erro:', err)
              return
            }
            for (const e of events) onEvent(projectId, w, e.path)
          },
          { ignore: ['.git', 'node_modules', '**/.git/**', '**/node_modules/**'] }
        )
        if (w.stopped) await sub.unsubscribe()
        else w.sub = sub
      } catch (e) {
        if (watched.get(projectId) === w) watched.delete(projectId)
        throw e
      }
    },
    stop,
    async stopAll() {
      await Promise.all([...watched.keys()].map((id) => stop(id)))
    }
  }
}
