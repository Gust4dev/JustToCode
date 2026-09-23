import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DownloadProgress } from '../../shared/components'

export interface DownloadParams {
  id: string
  label: string
  url: string
  dest: string
  sha256?: string | null
  signal?: AbortSignal
  onProgress(p: DownloadProgress): void
  fetchImpl?: typeof fetch
  /** Intervalo mínimo entre eventos de progresso (ms). */
  progressIntervalMs?: number
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
}

function parseTotal(res: Response, offset: number): number | null {
  const range = res.headers.get('content-range') // "bytes 100-999/1000"
  const m = range ? /\/(\d+)\s*$/.exec(range) : null
  if (m) return Number(m[1])
  const len = res.headers.get('content-length')
  return len !== null && /^\d+$/.test(len) ? offset + Number(len) : null
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e instanceof Error && e.name === 'AbortError')
}

/**
 * Baixa `url` para `dest` via `dest.part` (retomável com `Range`). Rename só no fim, após conferir o
 * SHA-256 quando informado. Cancelamento mantém o `.part` para retomar; hash errado apaga o `.part`.
 */
export async function download(p: DownloadParams): Promise<void> {
  const fetchImpl = p.fetchImpl ?? fetch
  const part = `${p.dest}.part`
  const interval = p.progressIntervalMs ?? 250
  let received = 0
  let total: number | null = null
  const emit = (done: boolean, error: string | null): void =>
    p.onProgress({ id: p.id, label: p.label, received, total, done, error })

  try {
    await mkdir(dirname(p.dest), { recursive: true })
    let offset = await fileSize(part)

    const request = (from: number): Promise<Response> =>
      fetchImpl(p.url, {
        headers: from > 0 ? { Range: `bytes=${from}-` } : {},
        signal: p.signal,
        redirect: 'follow'
      })

    let res = await request(offset)
    if (res.status === 416 && offset > 0) {
      // .part inválido para o recurso atual (maior que ele, ou mudou): recomeça do zero.
      await res.body?.cancel().catch(() => undefined)
      offset = 0
      res = await request(0)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${p.url}`)
    if (res.status !== 206) offset = 0 // servidor ignorou Range → recomeça
    if (!res.body) throw new Error('resposta sem corpo')

    total = parseTotal(res, offset)
    received = offset
    const hash = p.sha256 ? createHash('sha256') : null
    if (hash && offset > 0) await hashFile(part, hash)

    const out = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
    const closed = new Promise<void>((resolve, reject) => {
      out.once('close', resolve)
      out.once('error', reject)
    })
    let last = 0
    emit(false, null)
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash?.update(value)
        received += value.byteLength
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        const now = Date.now()
        if (now - last >= interval) {
          last = now
          emit(false, null)
        }
      }
    } finally {
      out.end()
      await closed
    }

    if (total !== null && received !== total) {
      throw new Error(`download incompleto (${received} de ${total} bytes)`)
    }
    if (hash) {
      const got = hash.digest('hex')
      if (got.toLowerCase() !== p.sha256!.toLowerCase()) {
        await rm(part, { force: true })
        throw new Error(`SHA-256 não confere (esperado ${p.sha256}, obtido ${got})`)
      }
    }
    await rename(part, p.dest)
    total = received
    emit(true, null)
  } catch (e) {
    const msg = isAbort(e, p.signal) ? 'cancelado' : e instanceof Error ? e.message : String(e)
    emit(true, msg)
    if (isAbort(e, p.signal)) {
      const err = new Error('download cancelado')
      err.name = 'AbortError'
      throw err
    }
    throw e
  }
}
