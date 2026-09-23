import type { FileChange } from '@shared/domain'
import type { HostContext } from '../context'
import type { FileChangeRepo } from '../repo/fileChanges'
import type { CaptureMeta, ChangeCapture } from '../services/types'
import {
  changedSince,
  dirtyPaths,
  headOid,
  indexContent,
  sha256,
  snapshot,
  MAX_BLOB_BYTES
} from './gitState'
import { CommandWindowRegistry, RecentToolWrites, type CommandWindow } from './commandWindows'

const toPosix = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

export interface CaptureDeps {
  /** Janelas de comando compartilhadas com o watcher (padrão: registro próprio). */
  registry?: CommandWindowRegistry
  /** Escritas de ferramenta recentes, para o watcher não duplicá-las. */
  toolWrites?: RecentToolWrites
}

export function createChangeCapture(
  ctx: HostContext,
  repo: FileChangeRepo,
  deps: CaptureDeps = {}
): ChangeCapture {
  const registry = deps.registry ?? new CommandWindowRegistry()
  const toolWrites = deps.toolWrites ?? new RecentToolWrites()
  const touched = (c: FileChange): void => {
    ctx.emit({
      type: 'file_touched',
      projectId: c.projectId,
      chatId: c.chatId,
      path: c.path,
      origin: c.origin
    })
  }

  const hashOf = (buf: Buffer): string =>
    buf.length <= MAX_BLOB_BYTES ? ctx.blobs.put(buf) : sha256(buf)

  async function runCommand<T>(
    win: CommandWindow,
    m: CaptureMeta,
    fn: () => Promise<T>
  ): Promise<{ result: T; changes: FileChange[] }> {
    const root = m.projectRoot
    // Arquivo limpo ⇒ árvore == índice == HEAD. Guardar o HEAD de antes deixa o "antes" dos
    // limpos imune a `git add`/`git commit` feitos pelo próprio comando.
    const headBefore = await headOid(root)
    const before = await snapshot(root, ctx.blobs, await dirtyPaths(root))

    let result: T | undefined
    let failure: { error: unknown } | null = null
    try {
      result = await fn()
    } catch (error) {
      failure = { error }
    }

    const afterDirty = await dirtyPaths(root)
    // Se o comando commitou, arquivos alterados e commitados não aparecem mais no status.
    const committed =
      headBefore !== null && (await headOid(root)) !== headBefore
        ? await changedSince(root, headBefore)
        : []
    const candidates = [...new Set([...before.files.keys(), ...afterDirty, ...committed])].sort()
    const after = await snapshot(root, ctx.blobs, candidates)

    // Outros chats com comando rodando ao mesmo tempo ⇒ não dá para saber quem mudou o quê.
    const others = [...new Set(registry.overlapping(m.projectId, win).map((o) => o.chatId))]
    const ambiguous = others.length > 0

    const changes: FileChange[] = []
    for (const path of candidates) {
      const afterState = after.files.get(path)
      if (!afterState) continue // virou pasta ou não é arquivo
      let beforeHash: string | null
      const prev = before.files.get(path)
      if (prev) {
        beforeHash = prev.hash
      } else {
        // Estava limpo: o antes é o conteúdo rastreado (null se não rastreado = arquivo novo).
        const buf = headBefore === null ? null : await indexContent(root, path, headBefore)
        beforeHash = buf === null ? null : hashOf(buf)
      }
      // Algo (ferramenta ou comando de outro chat) já registrou este caminho durante a janela:
      // não reatribuir o mesmo estado; se mudou depois, o antes é o que foi registrado.
      const last = repo.lastForPath(m.projectId, path)
      if (last && last.createdAt >= win.start) {
        if (last.afterHash === afterState.hash) continue
        beforeHash = last.afterHash
      }
      if (beforeHash === afterState.hash) continue
      const c = repo.insert({
        projectId: m.projectId,
        chatId: ambiguous ? null : m.chatId,
        candidateChatIds: ambiguous ? [m.chatId, ...others] : [],
        origin: ambiguous ? 'ambiguous' : 'command',
        path,
        beforeHash,
        afterHash: afterState.hash,
        toolCallId: m.toolCallId
      })
      changes.push(c)
      touched(c)
    }

    if (failure) throw failure.error
    return { result: result as T, changes }
  }

  return {
    recordToolWrite(m: CaptureMeta, relPath, before, after): FileChange | null {
      if (before === null && after === null) return null
      if (before !== null && after !== null && before.equals(after)) return null
      const path = toPosix(relPath)
      const afterHash = after === null ? null : ctx.blobs.put(after)
      toolWrites.mark(m.projectId, path, afterHash)
      const c = repo.insert({
        projectId: m.projectId,
        chatId: m.chatId,
        candidateChatIds: [],
        origin: 'tool',
        path,
        beforeHash: before === null ? null : ctx.blobs.put(before),
        afterHash,
        toolCallId: m.toolCallId
      })
      touched(c)
      return c
    },

    async withCommand<T>(
      m: CaptureMeta,
      fn: () => Promise<T>
    ): Promise<{ result: T; changes: FileChange[] }> {
      const win = registry.open({
        projectId: m.projectId,
        chatId: m.chatId,
        toolCallId: m.toolCallId
      })
      try {
        return await runCommand(win, m, fn)
      } finally {
        registry.close(win.id)
      }
    }
  }
}
