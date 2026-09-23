import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { diffLines } from 'diff'
import { RpcError } from '@shared/rpc'
import type { HostParams, HostResult } from '@shared/api'
import type { ChangeOrigin, ChangedFileSummary, FileChange } from '@shared/domain'
import type { HostContext } from '../context'
import type { FileChangeRepo } from '../repo/fileChanges'
import type { ProjectRepo } from '../repo/projects'
import { MAX_BLOB_BYTES, sha256 } from './gitState'
import { threeWayMerge } from './merge'

export interface ChangesService {
  list(p: HostParams<'changes.list'>): Promise<HostResult<'changes.list'>>
  fileDiff(p: HostParams<'changes.fileDiff'>): Promise<HostResult<'changes.fileDiff'>>
  accept(p: HostParams<'changes.accept'>): HostResult<'changes.accept'>
  revert(p: HostParams<'changes.revert'>): Promise<HostResult<'changes.revert'>>
  resolveConflict(
    p: HostParams<'changes.resolveConflict'>
  ): Promise<HostResult<'changes.resolveConflict'>>
}

export const REVERT_CONFLICT_MESSAGE =
  'O arquivo mudou depois deste chat e as mudanças se sobrepõem. Escolha como resolver.'
export const BINARY_CONFLICT_MESSAGE =
  'O arquivo mudou depois deste chat e é binário: não dá para mesclar. Escolha manter o atual ou aplicar a reversão.'
export const NO_BLOB_CONFLICT_MESSAGE =
  'O arquivo mudou depois deste chat e o conteúdo não foi guardado (arquivo grande demais): não dá para mesclar.'

const toPosix = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** Conteúdo em disco agora (null = não existe; pastas contam como inexistentes). */
async function readDisk(abs: string): Promise<Buffer | null> {
  try {
    const st = await stat(abs)
    if (!st.isFile()) return null
    return await readFile(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

const isBinary = (buf: Buffer | null): boolean => buf !== null && buf.includes(0)

function countLines(before: string, after: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count
    else if (part.removed) deletions += part.count
  }
  return { additions, deletions }
}

export function createChangesService(
  ctx: HostContext,
  repo: FileChangeRepo,
  projects: ProjectRepo
): ChangesService {
  const rootOf = (projectId: string): string => {
    const p = projects.get(projectId)
    if (!p) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
    return p.path
  }

  const absOf = (root: string, rel: string): string => {
    if (typeof rel !== 'string' || rel.trim() === '' || isAbsolute(rel)) {
      throw new RpcError('Caminho inválido', 'INVALID_PATH')
    }
    const abs = resolve(root, rel)
    const back = relative(root, abs)
    if (back === '' || back.startsWith('..') || isAbsolute(back)) {
      throw new RpcError('Caminho fora do projeto', 'INVALID_PATH')
    }
    return abs
  }

  /** Conteúdo de um hash guardado; `undefined` = hash existe mas o blob não (arquivo grande). */
  const blobContent = (hash: string | null): Buffer | null | undefined => {
    if (hash === null) return null
    return ctx.blobs.get(hash) ?? undefined
  }

  const groupByPath = (changes: FileChange[]): Map<string, FileChange[]> => {
    const map = new Map<string, FileChange[]>()
    for (const c of changes) {
      const arr = map.get(c.path)
      if (arr) arr.push(c)
      else map.set(c.path, [c])
    }
    return map
  }

  const hashForStore = (buf: Buffer): string =>
    buf.length <= MAX_BLOB_BYTES ? ctx.blobs.put(buf) : sha256(buf)

  interface Target {
    projectId: string
    rel: string
    abs: string
    pendingBefore: FileChange[]
    mine: FileChange[]
    current: Buffer | null
    currentHash: string | null
  }

  const target = async (projectId: string, chatId: string, path: string): Promise<Target> => {
    const root = rootOf(projectId)
    const rel = toPosix(path)
    const abs = absOf(root, rel)
    const pendingBefore = repo.forPath(projectId, rel)
    const mine = pendingBefore.filter((c) => c.chatId === chatId)
    if (mine.length === 0) {
      throw new RpcError('Este chat não tem mudanças pendentes neste arquivo', 'NOT_FOUND')
    }
    const current = await readDisk(abs)
    const currentHash = current === null ? null : sha256(current)
    return { projectId, rel, abs, pendingBefore, mine, current, currentHash }
  }

  /** Grava `next` (null = apaga), registra o revert e marca as mudanças do chat como revertidas. */
  const applyRevert = async (t: Target, next: Buffer | null): Promise<void> => {
    if (next === null) {
      await rm(t.abs, { force: true })
    } else {
      await mkdir(dirname(t.abs), { recursive: true })
      await writeFile(t.abs, next)
    }
    const nextHash = next === null ? null : hashForStore(next)
    repo.markReverted(t.mine.map((c) => c.id))
    const c = repo.insert({
      projectId: t.projectId,
      chatId: null,
      candidateChatIds: [],
      origin: 'tool',
      path: t.rel,
      beforeHash: t.current === null ? null : hashForStore(t.current),
      afterHash: nextHash,
      toolCallId: null
    })
    ctx.emit({
      type: 'file_touched',
      projectId: t.projectId,
      chatId: null,
      path: c.path,
      origin: c.origin
    })
    // Se o arquivo voltou à base (antes da primeira mudança pendente), não há mudança líquida.
    if (t.pendingBefore[0].beforeHash === nextHash) {
      repo.markReviewed(repo.forPath(t.projectId, t.rel).map((p) => p.id))
    }
  }

  return {
    async list({ projectId, chatId }) {
      const root = rootOf(projectId)
      const all = groupByPath(repo.listUnreviewed(projectId))
      const out: ChangedFileSummary[] = []
      for (const [path, changes] of all) {
        if (chatId && !changes.some((c) => c.chatId === chatId)) continue
        const baseHash = changes[0].beforeHash
        const current = await readDisk(absOf(root, path))
        const currentHash = current === null ? null : sha256(current)
        if (currentHash === baseHash) {
          // Mudança líquida zero: some da lista e fica marcado como revisado (preguiçoso).
          repo.markReviewed(changes.map((c) => c.id))
          continue
        }
        const base = blobContent(baseHash)
        const chatIds = [
          ...new Set(changes.map((c) => c.chatId).filter((c): c is string => c !== null))
        ]
        const origins = [...new Set(changes.map((c) => c.origin))] as ChangeOrigin[]
        // Sem blob da base (arquivo grande) não dá para contar linhas: trata como binário.
        const binary = base === undefined || isBinary(base ?? null) || isBinary(current)
        const counts = binary
          ? { additions: 0, deletions: 0 }
          : countLines(base?.toString('utf8') ?? '', current?.toString('utf8') ?? '')
        out.push({ path, chatIds, origins, baseHash, currentHash, ...counts, binary })
      }
      return out.sort((a, b) => a.path.localeCompare(b.path))
    },

    async fileDiff({ projectId, path, chatId }) {
      const root = rootOf(projectId)
      const rel = toPosix(path)
      const abs = absOf(root, rel)
      const changes = repo.forPath(projectId, rel).filter((c) => !chatId || c.chatId === chatId)
      const baseHash = changes.length > 0 ? changes[0].beforeHash : null
      const current = await readDisk(abs)
      if (changes.length === 0) {
        // Nada pendente: base = atual.
        if (isBinary(current)) return { before: null, after: null, binary: true }
        const text = current === null ? null : current.toString('utf8')
        return { before: text, after: text, binary: false }
      }
      const base = blobContent(baseHash)
      if (base === undefined || isBinary(base) || isBinary(current)) {
        return { before: null, after: null, binary: true }
      }
      return {
        before: base === null ? null : base.toString('utf8'),
        after: current === null ? null : current.toString('utf8'),
        binary: false
      }
    },

    accept({ projectId, path, chatId }) {
      rootOf(projectId)
      const rel = path ? toPosix(path) : null
      const ids = repo
        .listUnreviewed(projectId, chatId)
        .filter((c) => rel === null || c.path === rel)
        .map((c) => c.id)
      repo.markReviewed(ids)
      return null
    },

    async revert({ projectId, chatId, path }) {
      const t = await target(projectId, chatId, path)
      const { mine, current, currentHash } = t
      const beforeChat = mine[0].beforeHash
      const afterChat = mine[mine.length - 1].afterHash
      const original = blobContent(beforeChat)
      if (currentHash === afterChat) {
        // Caminho direto: ninguém mexeu depois deste chat.
        if (original === undefined) {
          return {
            status: 'conflict',
            message: 'O conteúdo original não foi guardado (arquivo grande demais).'
          }
        }
        await applyRevert(t, original)
        return { status: 'reverted' }
      }
      // Alguém mexeu depois: merge de três vias (atual, base = depois_chat, outro = antes_chat).
      const after = blobContent(afterChat)
      if (original === undefined || after === undefined) {
        return { status: 'conflict', message: NO_BLOB_CONFLICT_MESSAGE }
      }
      if (isBinary(original) || isBinary(after) || isBinary(current)) {
        return { status: 'conflict', message: BINARY_CONFLICT_MESSAGE }
      }
      const curText = current?.toString('utf8') ?? ''
      const baseText = after?.toString('utf8') ?? ''
      const revText = original?.toString('utf8') ?? ''
      const merged = await threeWayMerge(curText, baseText, revText)
      // Criação/remoção envolvida (algum lado não existe): nunca apaga nem recria sozinho.
      const existence = original === null || after === null || current === null
      if (merged.clean && !existence) {
        await applyRevert(t, Buffer.from(merged.text, 'utf8'))
        return { status: 'reverted' }
      }
      return {
        status: 'conflict',
        message: REVERT_CONFLICT_MESSAGE,
        conflict: {
          path: t.rel,
          base: baseText,
          current: curText,
          reverted: revText,
          merged: merged.text
        }
      }
    },

    async resolveConflict({ projectId, chatId, path, choice, content }) {
      const t = await target(projectId, chatId, path)
      if (choice === 'keep-current') {
        repo.markReviewed(t.mine.map((c) => c.id))
        return null
      }
      if (choice === 'apply-revert') {
        const original = blobContent(t.mine[0].beforeHash)
        if (original === undefined) {
          throw new RpcError(
            'O conteúdo original não foi guardado (arquivo grande demais).',
            'NOT_FOUND'
          )
        }
        await applyRevert(t, original)
        return null
      }
      if (choice === 'manual') {
        if (typeof content !== 'string') {
          throw new RpcError('Conteúdo manual ausente', 'INVALID_PARAMS')
        }
        await applyRevert(t, Buffer.from(content, 'utf8'))
        return null
      }
      throw new RpcError('Escolha inválida', 'INVALID_PARAMS')
    }
  }
}
