import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { download } from '../../src/main/components/downloader'
import { createComponentsContext, registerCore } from '../../src/main/components/context'
import type { ComponentHandlers } from '../../src/main/components/ipc'
import type { DownloadProgress } from '../../src/shared/components'

const DATA = randomBytes(256 * 1024)
const SHA = createHash('sha256').update(DATA).digest('hex')

let server: Server
let base: string
let dir: string
const seenRanges: (string | undefined)[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jtc-dl-'))
  seenRanges.length = 0
  server = createServer((req, res) => {
    seenRanges.push(req.headers.range)
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (req.url === '/file' && m) {
      const from = Number(m[1])
      if (from >= DATA.length) {
        res.writeHead(416)
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Length': DATA.length - from,
        'Content-Range': `bytes ${from}-${DATA.length - 1}/${DATA.length}`
      })
      res.end(DATA.subarray(from))
      return
    }
    if (req.url === '/file' || req.url === '/norange') {
      res.writeHead(200, { 'Content-Length': DATA.length })
      res.end(DATA)
      return
    }
    if (req.url === '/slow') {
      // Manda metade e trava (para testar cancelamento).
      res.writeHead(200, { 'Content-Length': DATA.length })
      res.write(DATA.subarray(0, DATA.length / 2))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  rmSync(dir, { recursive: true, force: true })
})

function collector(): { events: DownloadProgress[]; onProgress(p: DownloadProgress): void } {
  const events: DownloadProgress[] = []
  return { events, onProgress: (p) => events.push(p) }
}

describe('download', { timeout: 30_000 }, () => {
  it('completo: grava via .part, confere hash e renomeia', async () => {
    const dest = join(dir, 'sub', 'm.gguf')
    const c = collector()
    await download({ id: 'd1', label: 'M', url: `${base}/file`, dest, sha256: SHA, ...c })
    expect(readFileSync(dest).equals(DATA)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(seenRanges).toEqual([undefined])
    const last = c.events.at(-1)!
    expect(last).toMatchObject({ id: 'd1', done: true, error: null, received: DATA.length })
    expect(last.total).toBe(DATA.length)
  })

  it('retoma com Range a partir do .part existente', async () => {
    const dest = join(dir, 'm.gguf')
    writeFileSync(`${dest}.part`, DATA.subarray(0, 1000))
    const c = collector()
    await download({ id: 'd', label: 'M', url: `${base}/file`, dest, sha256: SHA, ...c })
    expect(seenRanges).toEqual(['bytes=1000-'])
    expect(readFileSync(dest).equals(DATA)).toBe(true)
    expect(c.events.at(-1)?.total).toBe(DATA.length)
  })

  it('servidor ignora Range (200) → recomeça do zero', async () => {
    const dest = join(dir, 'm.gguf')
    writeFileSync(`${dest}.part`, Buffer.from('lixo-que-nao-e-do-arquivo'))
    await download({
      id: 'd',
      label: 'M',
      url: `${base}/norange`,
      dest,
      sha256: SHA,
      onProgress: () => {}
    })
    expect(seenRanges).toEqual(['bytes=25-'])
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  it('416 (.part do tamanho/maior que o recurso) → recomeça', async () => {
    const dest = join(dir, 'm.gguf')
    writeFileSync(`${dest}.part`, Buffer.concat([DATA, Buffer.from('x')]))
    await download({ id: 'd', label: 'M', url: `${base}/file`, dest, onProgress: () => {} })
    expect(seenRanges).toEqual([`bytes=${DATA.length + 1}-`, undefined])
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  it('hash errado → erro, apaga .part, não cria dest', async () => {
    const dest = join(dir, 'm.gguf')
    const c = collector()
    await expect(
      download({ id: 'd', label: 'M', url: `${base}/file`, dest, sha256: '0'.repeat(64), ...c })
    ).rejects.toThrow(/SHA-256/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(c.events.at(-1)).toMatchObject({ done: true, error: expect.stringMatching(/SHA-256/) })
  })

  it('HTTP 404 → erro claro', async () => {
    await expect(
      download({
        id: 'd',
        label: 'M',
        url: `${base}/nada`,
        dest: join(dir, 'x'),
        onProgress: () => {}
      })
    ).rejects.toThrow(/HTTP 404/)
  })

  it('cancelamento → AbortError, mantém .part para retomar', async () => {
    const dest = join(dir, 'm.gguf')
    const ctrl = new AbortController()
    const c = collector()
    const p = download({
      id: 'd',
      label: 'M',
      url: `${base}/slow`,
      dest,
      signal: ctrl.signal,
      progressIntervalMs: 0,
      onProgress: (e) => {
        c.onProgress(e)
        if (e.received > 0 && !e.done) ctrl.abort()
      }
    })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(true)
    expect(c.events.at(-1)).toMatchObject({ done: true, error: 'cancelado' })
  })
})

describe('contexto: startDownload + cancelDownload', { timeout: 30_000 }, () => {
  it('cancelDownload aborta o download registrado', async () => {
    const events: DownloadProgress[] = []
    const ctx = createComponentsContext({
      userData: dir,
      emitStatus: () => {},
      emitLog: () => {},
      emitProgress: (p) => {
        events.push(p)
        if (p.received > 0 && !p.done) void handlers['cancelDownload']('x')
      }
    })
    const handlers: ComponentHandlers = {}
    registerCore(ctx, handlers)
    const p = ctx.startDownload({
      id: 'x',
      label: 'X',
      url: `${base}/slow`,
      dest: join(dir, 'x.bin'),
      progressIntervalMs: 0
    })
    expect(ctx.downloads.has('x')).toBe(true)
    await expect(
      ctx.startDownload({ id: 'x', label: 'X', url: `${base}/file`, dest: join(dir, 'y') })
    ).rejects.toThrow(/andamento/)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(ctx.downloads.has('x')).toBe(false)
    expect(events.at(-1)).toMatchObject({ id: 'x', error: 'cancelado' })
    // id desconhecido: no-op
    await handlers['cancelDownload']('nao-existe')
  })
})
